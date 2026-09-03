import { readFileSync } from "node:fs";
import type { Server } from "bun";
import { type Args, bearerToken, parseArgs } from "./body.ts";
import {
  appMentionEvent,
  assistantThreadContextChangedEvent,
  assistantThreadStartedEvent,
  blockActionsPayload,
  eventCallback,
  memberJoinedEvent,
  messageChangedEvent,
  messageDeletedEvent,
  messageEvent,
  reactionEvent,
  slashCommandPayload,
  viewSubmissionPayload,
} from "./events.ts";
import { slackId } from "./ids.ts";
import { renderPage } from "./render/index.ts";
import {
  type AckResult,
  type ConnData,
  type DeliveryRecord,
  SocketModeClosedError,
  SocketModeHub,
} from "./socket-mode.ts";
import {
  type AddChannelInput,
  type AddUserInput,
  ensureDir,
  SlackApiError,
  Store,
  type StoreOptions,
  wireMessage,
} from "./store.ts";
import type { ApiCall, Change, SlackChannel, SlackMessage, SlackUser } from "./types.ts";
import { type Actor, type ApiContext, handlers, newTriggerId } from "./web-api.ts";

export interface SlackManifest {
  display_information?: { name?: string };
  features?: {
    bot_user?: { display_name?: string };
    slash_commands?: Array<{ command: string; description?: string }>;
  };
  settings?: { event_subscriptions?: { bot_events?: string[] } };
}

export interface SlackMockOptions extends StoreOptions {
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** Path to a Slack app manifest JSON, or the parsed manifest. Sets app name, commands and event subscriptions. */
  manifest?: string | SlackManifest;
  /** Create a default workspace (#general, two humans). Default true. */
  seed?: boolean;
  /** Deliver the bot's own messages back as events, like Slack does. Default true. */
  echoBotMessages?: boolean;
  /** Event types (manifest style, e.g. "message.channels") to push to the app. */
  subscribedEvents?: string[];
  pingIntervalMs?: number;
  ackTimeoutMs?: number;
  maxRetries?: number;
  /** How long a trigger_id stays valid for views.open (Slack: 3s). */
  triggerIdTtlMs?: number;
  /** Delay before each event is pushed (emulates Slack latency). */
  eventDelayMs?: number;
  /** Default width of the thread side panel in the HTML UI, e.g. "50%" or "640px". `?panel=` overrides per request. */
  panelWidth?: string;
  log?: boolean | ((msg: string) => void);
}

export interface PostMessageInput {
  channel: string;
  /** Sending user id; defaults to the first seeded human. */
  user?: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
  files?: Array<{ name: string; content: string | Uint8Array; title?: string; mimetype?: string }>;
  reply_broadcast?: boolean;
}

export interface MessageQuery {
  channel?: string;
  thread_ts?: string;
  /** "bot", "human", or a user id. */
  from?: string;
  text?: string | RegExp;
  /** Match against message.metadata.event_type. */
  event_type?: string;
  /** Include ephemeral messages (default false). */
  ephemeral?: boolean;
}

const DEFAULT_EVENTS = [
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "app_mention",
  "assistant_thread_started",
  "assistant_thread_context_changed",
  "reaction_added",
  "reaction_removed",
  "member_joined_channel",
];

export interface Fault {
  /** Web API method to fail, e.g. "chat.postMessage". */
  method: string;
  /** Slack error code to return, e.g. "ratelimited" or "missing_scope". */
  error: string;
  /** How many calls to fail (default 1). */
  times?: number;
  /** HTTP status (default 200, like Slack). Use 429 with retryAfterSec to test rate limiting. */
  httpStatus?: number;
  retryAfterSec?: number;
  /** Extra body fields, e.g. { needed: "chat:write" }. */
  extra?: Record<string, unknown>;
}

interface ResponseUrl {
  channel: string;
  user: string;
  /** The message that owns the response_url (for replace_original). */
  messageTs?: string;
  expires: number;
}

export class SlackMock {
  readonly store: Store;
  readonly hub: SocketModeHub;
  readonly opts: SlackMockOptions;
  private server!: Server<ConnData>;
  private triggerIds = new Map<string, number>();
  private pendingUploads: ApiContext["pendingUploads"] = new Map();
  private responseUrls = new Map<string, ResponseUrl>();
  private inflight = new Set<Promise<void>>();
  private subscribed: Set<string>;
  private commands: Set<string> | null = null;
  private faults: Array<Fault & { remaining: number }> = [];
  private lastRequestAt = 0;
  private log: (msg: string) => void;
  /** Slack-facing errors with the same shape Slack returns. */
  static Error = SlackApiError;

  constructor(opts: SlackMockOptions = {}) {
    const manifest =
      typeof opts.manifest === "string"
        ? (JSON.parse(readFileSync(opts.manifest, "utf8")) as SlackManifest)
        : opts.manifest;
    const appName =
      opts.appName ??
      manifest?.features?.bot_user?.display_name ??
      manifest?.display_information?.name;
    this.opts = { ...opts, appName };
    this.log =
      typeof opts.log === "function"
        ? opts.log
        : opts.log
          ? (m) => console.log(`[slack-mock] ${m}`)
          : () => {};
    if (opts.dataFile) ensureDir(opts.dataFile);
    this.store = new Store({ ...opts, appName });
    this.hub = new SocketModeHub({
      appId: this.store.app.id,
      pingIntervalMs: opts.pingIntervalMs,
      ackTimeoutMs: opts.ackTimeoutMs,
      maxRetries: opts.maxRetries,
      log: this.log,
    });
    this.subscribed = new Set(
      opts.subscribedEvents ??
        manifest?.settings?.event_subscriptions?.bot_events ??
        DEFAULT_EVENTS,
    );
    if (manifest?.features?.slash_commands)
      this.commands = new Set(manifest.features.slash_commands.map((c) => c.command));
    if (opts.seed !== false && this.store.channels.size === 0) this.seed();
    this.store.onChange((change) => this.dispatch(change));
  }

  static async start(opts: SlackMockOptions = {}): Promise<SlackMock> {
    const mock = new SlackMock(opts);
    mock.listen();
    return mock;
  }

  private seed(): void {
    const alice = this.store.addUser({
      id: "U0ALICE000",
      name: "alice",
      real_name: "Alice Example",
      email: "alice@example.com",
      is_admin: true,
    });
    const bob = this.store.addUser({
      id: "U0BOB00000",
      name: "bob",
      real_name: "Bob Example",
      email: "bob@example.com",
    });
    this.store.addChannel({
      id: "C0GENERAL0",
      name: "general",
      creator: alice.id,
      members: [alice.id, bob.id, this.store.bot.userId],
      purpose: "Company-wide announcements",
    });
  }

  // --------------------------------------------------------------- server

  listen(): void {
    const host = this.opts.host ?? "127.0.0.1";
    this.server = Bun.serve<ConnData>({
      hostname: host,
      port: this.opts.port ?? 0,
      fetch: (req, server) => this.fetch(req, server),
      websocket: {
        open: (ws) => this.hub.open(ws),
        message: (ws, msg) => this.hub.message(ws, msg),
        close: (ws) => this.hub.close(ws),
        ping: () => {},
        pong: () => {},
      },
    });
    this.log(`listening on ${this.baseUrl}`);
  }

  get baseUrl(): string {
    return `http://${this.server.hostname}:${this.server.port}`;
  }

  get apiUrl(): string {
    return `${this.baseUrl}/api/`;
  }

  get port(): number {
    return this.server.port ?? 0;
  }

  /** Environment variables a Bolt app needs to talk to this mock. */
  get env(): Record<string, string> {
    return {
      SLACK_BOT_TOKEN: this.store.bot.token,
      SLACK_APP_TOKEN: this.store.bot.appToken,
      SLACK_API_URL: this.apiUrl,
      SLACK_SIGNING_SECRET: "mock-signing-secret",
    };
  }

  get bot() {
    return this.store.bot;
  }

  get team() {
    return this.store.team;
  }

  async stop(): Promise<void> {
    this.hub.shutdown();
    await Promise.allSettled([...this.inflight]);
    this.server.stop(true);
  }

  private async fetch(req: Request, server: Server<ConnData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    this.lastRequestAt = Date.now();
    try {
      if (path.startsWith("/link/") || path === "/link") {
        const ticket = url.searchParams.get("ticket") ?? "";
        if (!this.hub.tickets.has(ticket)) return new Response("invalid ticket", { status: 403 });
        this.hub.tickets.delete(ticket);
        if (server.upgrade(req, { data: { id: slackId("S", 6), ticket } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (path.startsWith("/api/")) return await this.handleApi(req, path.slice(5));
      if (path.startsWith("/upload/v1/"))
        return await this.handleUpload(req, path.slice("/upload/v1/".length));
      if (path.startsWith("/files-pri/")) return this.handleDownload(req, path);
      if (path.startsWith("/actions/"))
        return await this.handleResponseUrl(req, path.slice("/actions/".length));
      if (path.startsWith("/mock/")) return await this.handleAdmin(req, path.slice(6), url);
      return this.handleUi(path, url);
    } catch (e) {
      this.log(`unhandled error on ${req.method} ${path}: ${e instanceof Error ? e.stack : e}`);
      return new Response(String(e), { status: 500 });
    }
  }

  private actorFor(token: string | undefined): Actor | null {
    if (!token) return null;
    if (token === this.store.bot.token || token === this.store.bot.appToken)
      return { userId: this.store.bot.userId, isBot: true };
    if (this.store.bot.userToken && token === this.store.bot.userToken) {
      const human = [...this.store.users.values()].find((u) => !u.is_bot);
      return human ? { userId: human.id, isBot: false } : null;
    }
    return null;
  }

  private async handleApi(req: Request, method: string): Promise<Response> {
    let args: Args = {};
    try {
      args = await parseArgs(req);
    } catch (e) {
      return slackError("invalid_form_data", { detail: String(e) });
    }
    const token = bearerToken(req, args);
    const actor = this.actorFor(token);
    const record = (ok: boolean, error?: string) => {
      const { token: _t, ...rest } = args;
      const call: ApiCall = {
        at: new Date().toISOString(),
        method,
        args: rest,
        ok,
        ...(error ? { error } : {}),
      };
      this.store.recordApiCall(call);
    };
    if (!token) {
      record(false, "not_authed");
      return slackError("not_authed");
    }
    if (!actor) {
      record(false, "invalid_auth");
      return slackError("invalid_auth");
    }
    if (method === "apps.connections.open" && token !== this.store.bot.appToken) {
      record(false, "not_allowed_token_type");
      return slackError("not_allowed_token_type");
    }
    const fault = this.faults.find((f) => f.method === method && f.remaining > 0);
    if (fault) {
      fault.remaining -= 1;
      record(false, fault.error);
      this.log(`${method} -> injected ${fault.error}`);
      return Response.json(
        {
          ok: false,
          error: fault.error,
          ...(fault.retryAfterSec ? { retry_after: fault.retryAfterSec } : {}),
          ...fault.extra,
        },
        {
          status: fault.httpStatus ?? 200,
          headers: fault.retryAfterSec ? { "retry-after": String(fault.retryAfterSec) } : {},
        },
      );
    }
    const handler = handlers[method];
    if (!handler) {
      record(false, "unknown_method");
      return slackError("unknown_method", { req_method: method });
    }
    const ctx: ApiContext = {
      store: this.store,
      hub: this.hub,
      baseUrl: this.baseUrl,
      wsUrl: this.baseUrl.replace(/^http/, "ws"),
      actor,
      triggerIds: this.triggerIds,
      pendingUploads: this.pendingUploads,
    };
    try {
      const body = handler(ctx, args);
      record(true);
      return Response.json({ ok: true, ...body });
    } catch (e) {
      if (e instanceof SlackApiError) {
        record(false, e.code);
        this.log(`${method} -> ${e.code}`);
        return slackError(e.code, e.extra);
      }
      throw e;
    }
  }

  private async handleUpload(req: Request, fileId: string): Promise<Response> {
    const pending = this.pendingUploads.get(fileId);
    if (!pending) return new Response("unknown upload", { status: 404 });
    let bytes: Uint8Array;
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      let part: File | undefined;
      form.forEach((v) => {
        if (typeof v !== "string" && !part) part = v;
      });
      bytes = part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array();
    } else {
      bytes = new Uint8Array(await req.arrayBuffer());
    }
    this.pendingUploads.delete(fileId);
    this.store.addFile({
      id: fileId,
      name: pending.name,
      user: pending.user,
      bytes,
      baseUrl: this.baseUrl,
    });
    return new Response("OK");
  }

  private handleDownload(req: Request, path: string): Response {
    const m = /^\/files-pri\/[A-Z0-9]+-([A-Z0-9]+)\/(?:download\/)?/.exec(path);
    const file = m ? this.store.files.get(m[1]!) : undefined;
    if (!file) return new Response("not found", { status: 404 });
    const token = bearerToken(req, {}) ?? new URL(req.url).searchParams.get("t") ?? undefined;
    if (!this.actorFor(token)) return new Response("authentication required", { status: 401 });
    return new Response(Buffer.from(file.bytes ?? new Uint8Array()), {
      headers: {
        "content-type": file.mimetype,
        "content-disposition": `attachment; filename="${file.name}"`,
        "content-length": String(file.size),
      },
    });
  }

  private async handleResponseUrl(req: Request, id: string): Promise<Response> {
    const target = this.responseUrls.get(id);
    if (!target) return new Response("invalid response_url", { status: 404 });
    if (Date.now() > target.expires) return new Response("expired_url", { status: 410 });
    let body: {
      text?: string;
      blocks?: unknown[];
      attachments?: unknown[];
      response_type?: string;
      replace_original?: boolean | string;
      delete_original?: boolean | string;
      thread_ts?: string;
    };
    try {
      body = (await parseArgs(req)) as typeof body;
    } catch (e) {
      return Response.json(
        { ok: false, error: "invalid_payload", detail: String(e) },
        { status: 400 },
      );
    }
    const isTrue = (v: unknown) => v === true || v === "true";
    try {
      if (isTrue(body.delete_original) && target.messageTs) {
        if (this.store.findMessage(target.channel, target.messageTs))
          this.store.deleteMessage(target.channel, target.messageTs);
        else this.store.deleteEphemeral(target.channel, target.messageTs);
        return new Response("ok");
      }
      if (isTrue(body.replace_original) && target.messageTs) {
        const patch = { text: body.text ?? "", blocks: body.blocks, attachments: body.attachments };
        if (this.store.findMessage(target.channel, target.messageTs))
          this.store.updateMessage(target.channel, target.messageTs, patch, this.store.bot.userId);
        else this.store.updateEphemeral(target.channel, target.messageTs, patch);
        return new Response("ok");
      }
    } catch (e) {
      if (e instanceof SlackApiError) return Response.json({ ok: false, error: e.code });
      throw e;
    }
    this.postAsBot({
      channel: target.channel,
      text: body.text ?? "",
      blocks: body.blocks,
      attachments: body.attachments,
      thread_ts: body.thread_ts,
      ephemeral_user: body.response_type === "in_channel" ? undefined : target.user,
    });
    return new Response("ok");
  }

  private postAsBot(input: {
    channel: string;
    text: string;
    blocks?: unknown[];
    attachments?: unknown[];
    thread_ts?: string;
    ephemeral_user?: string;
  }): SlackMessage {
    return this.store.addMessage({
      channel: input.channel,
      user: this.store.bot.userId,
      text: input.text,
      blocks: input.blocks,
      attachments: input.attachments,
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      ...(input.ephemeral_user ? { ephemeral_user: input.ephemeral_user } : {}),
      bot_id: this.store.bot.botId,
      app_id: this.store.app.id,
    });
  }

  private handleUi(path: string, url: URL): Response {
    const screenshotParam = url.searchParams.get("screenshot");
    const screenshot =
      screenshotParam !== null && screenshotParam !== "0" && screenshotParam !== "false";
    const refresh = Number(url.searchParams.get("refresh"));
    const panel = url.searchParams.get("panel") ?? this.opts.panelWidth;
    const opts = {
      screenshot,
      refreshSec: Number.isFinite(refresh) && refresh > 0 ? refresh : undefined,
      connections: this.hub.connectionCount,
      panelWidth: panel
        ? /^\d+$/.test(panel)
          ? `${panel}%`
          : /^\d+(px|%|vw|rem)$/.test(panel)
            ? panel
            : undefined
        : undefined,
      threadView: url.searchParams.has("full") ? ("full" as const) : ("panel" as const),
    };
    let html: string;
    if (path === "/" || path === "") html = renderPage(this.store, { kind: "index" }, opts);
    else {
      const m = /^\/c\/([^/]+)(?:\/t\/([^/]+))?\/?$/.exec(path);
      if (!m) return new Response("not found", { status: 404 });
      const channel = this.store.channelByName(m[1]!)?.id ?? m[1]!;
      if (!this.store.channels.has(channel))
        return new Response("channel not found", { status: 404 });
      html = m[2]
        ? renderPage(this.store, { kind: "thread", channel, ts: m[2] }, opts)
        : renderPage(this.store, { kind: "channel", channel }, opts);
    }
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // -------------------------------------------------- event dispatching

  private isSubscribed(type: string): boolean {
    return this.subscribed.has(type);
  }

  /** Manifest event name for a message in this channel: message.channels / groups / im / mpim. */
  private messageEventName(channel: SlackChannel): string {
    const t = this.store.channelType(channel);
    return `message.${t === "channel" ? "channels" : t === "group" ? "groups" : t}`;
  }

  private track(p: Promise<unknown>): Promise<void> {
    const wrapped = p.then(
      () => {},
      (e) => {
        if (!(e instanceof SocketModeClosedError))
          this.log(`delivery failed: ${e instanceof Error ? e.message : e}`);
      },
    );
    this.inflight.add(wrapped);
    wrapped.finally(() => this.inflight.delete(wrapped));
    return wrapped;
  }

  private push(event: Record<string, unknown>): Promise<void> {
    if (this.hub.connectionCount === 0) {
      this.log(
        `dropping ${event.type}${event.subtype ? `/${event.subtype}` : ""} event: no app connected`,
      );
      return Promise.resolve();
    }
    const send = async () => {
      if (this.opts.eventDelayMs) await Bun.sleep(this.opts.eventDelayMs);
      await this.hub.send("events_api", eventCallback(this.store, event));
    };
    return this.track(send());
  }

  private botInChannel(channel: SlackChannel): boolean {
    return channel.members.includes(this.store.bot.userId);
  }

  private dispatch(change: Change): void {
    switch (change.kind) {
      case "message.add": {
        const m = change.message;
        if (m.ephemeral_user || m.subtype === "assistant_app_thread") return;
        const channel = this.store.channel(m.channel);
        if (!this.botInChannel(channel)) return;
        const fromBot = this.store.isBotUser(m.user);
        if (fromBot && this.opts.echoBotMessages === false) return;
        const mentionsBot = !fromBot && m.text.includes(`<@${this.store.bot.userId}>`);
        if (mentionsBot && this.isSubscribed("app_mention"))
          this.push(appMentionEvent(this.store, m));
        if (this.isSubscribed(this.messageEventName(channel)))
          this.push(messageEvent(this.store, m, channel));
        return;
      }
      case "message.update": {
        const channel = this.store.channel(change.message.channel);
        if (this.botInChannel(channel) && this.isSubscribed(this.messageEventName(channel))) {
          this.push(messageChangedEvent(this.store, change.message, change.previous));
        }
        return;
      }
      case "message.delete": {
        const channel = this.store.channel(change.message.channel);
        if (this.botInChannel(channel) && this.isSubscribed(this.messageEventName(channel))) {
          this.push(messageDeletedEvent(this.store, change.message));
        }
        return;
      }
      case "reaction.add":
      case "reaction.remove": {
        const kind = change.kind === "reaction.add" ? "reaction_added" : "reaction_removed";
        if (
          this.isSubscribed(kind) &&
          this.botInChannel(this.store.channel(change.message.channel))
        ) {
          this.push(reactionEvent(kind, change.message, change.name, change.user));
        }
        return;
      }
      case "member.join": {
        if (this.isSubscribed("member_joined_channel") && this.botInChannel(change.channel)) {
          this.push(memberJoinedEvent(this.store, change.channel, change.user, change.inviter));
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Wait until every event pushed so far has been acked (or dropped) and the app
   * has been quiet on the HTTP side for `settleMs` (so respond() calls that follow
   * an ack have landed). Bounded by `maxMs`.
   */
  async flush(settleMs = 100, maxMs = 3000): Promise<void> {
    const start = Date.now();
    for (;;) {
      while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
      const quietSince = Math.max(this.lastRequestAt, start);
      const quiet = Date.now() - quietSince;
      if (quiet >= settleMs || Date.now() - start > maxMs) return;
      await Bun.sleep(settleMs - quiet + 5);
    }
  }

  // --------------------------------------------------- test-facing API

  addUser(input: AddUserInput): SlackUser {
    return this.store.addUser(input);
  }

  addChannel(input: AddChannelInput & { withBot?: boolean }): SlackChannel {
    const members = [...(input.members ?? [])];
    if (input.withBot !== false) members.push(this.store.bot.userId);
    const creator =
      input.creator ??
      (input.withBot === false ? (members[0] ?? this.defaultHuman().id) : this.store.bot.userId);
    return this.store.addChannel({ ...input, creator, members });
  }

  openDm(user: string): SlackChannel {
    return this.store.openDm(user);
  }

  invite(channel: string, users: string[], inviter?: string): void {
    for (const u of users) this.store.join(this.resolveChannel(channel).id, u, inviter);
  }

  user(idOrName: string): SlackUser {
    const byId = this.store.users.get(idOrName);
    if (byId) return byId;
    for (const u of this.store.users.values()) if (u.name === idOrName) return u;
    throw new SlackApiError("user_not_found");
  }

  channel(idOrName: string): SlackChannel {
    return this.resolveChannel(idOrName);
  }

  private resolveChannel(idOrName: string): SlackChannel {
    return (
      this.store.channels.get(idOrName) ??
      this.store.channelByName(idOrName) ??
      this.store.channel(idOrName)
    );
  }

  private defaultHuman(): SlackUser {
    const u = [...this.store.users.values()].find((x) => !x.is_bot);
    if (!u) throw new Error("no human user in the workspace; call addUser first");
    return u;
  }

  /** Turn `@name` and `@here` / `@channel` in human-typed text into Slack mention syntax. */
  resolveMentions(text: string): string {
    const byName = new Map<string, string>();
    for (const u of this.store.users.values()) byName.set(u.name.toLowerCase(), u.id);
    return text.replace(/(^|[^<\w])@([\w.-]+)/g, (whole, lead: string, name: string) => {
      const lower = name.toLowerCase();
      if (lower === "here" || lower === "channel" || lower === "everyone")
        return `${lead}<!${lower}>`;
      const id = byName.get(lower);
      return id ? `${lead}<@${id}>` : whole;
    });
  }

  /** A human posts a message; resolves once the app acked the resulting events. */
  async postMessage(input: PostMessageInput): Promise<SlackMessage> {
    const channel = this.resolveChannel(input.channel);
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    if (!channel.members.includes(user.id)) this.store.join(channel.id, user.id);
    const files = input.files?.map((f) =>
      this.store.addFile({
        name: f.name,
        title: f.title,
        mimetype: f.mimetype,
        user: user.id,
        bytes: typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content,
        baseUrl: this.baseUrl,
      }),
    );
    for (const f of files ?? []) f.channels.push(channel.id);
    const before = new Set(this.inflight);
    const message = this.store.addMessage({
      channel: channel.id,
      user: user.id,
      text: input.text,
      client_msg_id: crypto.randomUUID(),
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      ...(input.reply_broadcast && input.thread_ts ? { subtype: "thread_broadcast" } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(files?.length ? { files, subtype: "file_share" } : {}),
    });
    await Promise.allSettled([...this.inflight].filter((p) => !before.has(p)));
    return message;
  }

  /** A human edits their message. */
  async editMessage(channel: string, ts: string, text: string): Promise<SlackMessage> {
    const c = this.resolveChannel(channel);
    const existing = this.store.message(c.id, ts);
    const message = this.store.updateMessage(
      c.id,
      ts,
      { text },
      existing.user ?? this.defaultHuman().id,
    );
    await this.flush();
    return message;
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    this.store.deleteMessage(this.resolveChannel(channel).id, ts);
    await this.flush();
  }

  async addReaction(input: {
    channel: string;
    ts: string;
    name: string;
    user?: string;
  }): Promise<void> {
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    this.store.addReaction(this.resolveChannel(input.channel).id, input.ts, input.name, user.id);
    await this.flush();
  }

  private issueResponseUrl(target: Omit<ResponseUrl, "expires">): string {
    const id = `${this.store.team.id}/${slackId("", 10)}/${slackId("", 24).toLowerCase()}`;
    this.responseUrls.set(id, { ...target, expires: Date.now() + 30 * 60_000 });
    return `${this.baseUrl}/actions/${id}`;
  }

  private issueTriggerId(): string {
    const id = newTriggerId();
    this.triggerIds.set(id, Date.now() + (this.opts.triggerIdTtlMs ?? 3000));
    return id;
  }

  /** A human runs a slash command. Resolves with the app's ack payload and any message it produced. */
  async slashCommand(input: {
    command: string;
    text?: string;
    user?: string;
    channel?: string;
  }): Promise<{ ack: AckResult; response?: SlackMessage }> {
    if (this.commands && !this.commands.has(input.command))
      throw new Error(
        `unknown slash command ${input.command}; manifest declares ${[...this.commands].join(", ")}`,
      );
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    const channel = input.channel
      ? this.resolveChannel(input.channel)
      : (this.store.channelByName("general") ?? this.openDm(user.id));
    const responseUrl = this.issueResponseUrl({ channel: channel.id, user: user.id });
    const payload = slashCommandPayload(this.store, {
      command: input.command,
      text: input.text ?? "",
      user,
      channel,
      responseUrl,
      triggerId: this.issueTriggerId(),
    });
    const ack = await this.hub.send("slash_commands", payload, true);
    let response: SlackMessage | undefined;
    const body = ack.payload as
      | { text?: string; blocks?: unknown[]; response_type?: string }
      | undefined;
    if (body && (body.text || body.blocks)) {
      response = this.postAsBot({
        channel: channel.id,
        text: body.text ?? "",
        blocks: body.blocks,
        ephemeral_user: body.response_type === "in_channel" ? undefined : user.id,
      });
    }
    await this.flush();
    return { ack, response };
  }

  /** A human clicks a button on a message. */
  async clickButton(input: {
    channel: string;
    ts: string;
    action_id: string;
    user?: string;
    value?: string;
    block_id?: string;
    text?: string;
  }): Promise<AckResult> {
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    const channel = this.resolveChannel(input.channel);
    const message =
      this.store.findMessage(channel.id, input.ts) ??
      this.store.ephemerals.find((m) => m.channel === channel.id && m.ts === input.ts);
    if (!message) throw new SlackApiError("message_not_found");
    const found = findButton(message.blocks, input.action_id);
    if (!found && !input.value && !input.block_id)
      throw new Error(`no button with action_id ${input.action_id} on message ${input.ts}`);
    const responseUrl = this.issueResponseUrl({
      channel: channel.id,
      user: user.id,
      messageTs: message.ts,
    });
    const payload = blockActionsPayload(this.store, {
      user,
      channel,
      message,
      responseUrl,
      triggerId: this.issueTriggerId(),
      actions: [
        {
          type: "button",
          action_id: input.action_id,
          block_id: input.block_id ?? found?.block_id ?? slackId("", 5),
          text: found?.text ?? {
            type: "plain_text",
            text: input.text ?? input.action_id,
            emoji: true,
          },
          value: input.value ?? found?.value,
          ...(found?.style ? { style: found.style } : {}),
        },
      ],
    });
    const ack = await this.hub.send("interactive", payload, true);
    await this.flush();
    return ack;
  }

  /** A human submits the most recently opened modal (or the one with the given id / callback_id). */
  async submitView(input: {
    values: Record<string, Record<string, unknown>>;
    user?: string;
    view_id?: string;
    callback_id?: string;
  }): Promise<AckResult> {
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    const views = [...this.store.views.values()];
    const view = input.view_id
      ? this.store.views.get(input.view_id)
      : input.callback_id
        ? views.reverse().find((v) => v.callback_id === input.callback_id)
        : views.at(-1);
    if (!view) throw new Error("no open view to submit");
    view.state = { values: input.values };
    const payload = viewSubmissionPayload(this.store, {
      user,
      view,
      values: input.values,
      triggerId: this.issueTriggerId(),
    });
    const ack = await this.hub.send("interactive", payload, true);
    // Slack keeps the modal open on `errors`, swaps it on `update`, stacks on `push`, closes otherwise.
    const response = (ack.payload ?? {}) as {
      response_action?: string;
      view?: Record<string, unknown>;
      errors?: Record<string, string>;
    };
    if (response.response_action === "errors") {
      view.state = { values: input.values };
    } else if (response.response_action === "update" && response.view) {
      Object.assign(view, {
        callback_id: response.view.callback_id ?? view.callback_id,
        private_metadata: response.view.private_metadata ?? view.private_metadata,
        title: response.view.title ?? view.title,
        submit: response.view.submit ?? view.submit,
        blocks: Array.isArray(response.view.blocks) ? response.view.blocks : view.blocks,
      });
    } else if (response.response_action === "push" && response.view) {
      this.store.openView({
        type: "modal",
        callback_id: response.view.callback_id as string | undefined,
        private_metadata: (response.view.private_metadata as string | undefined) ?? "",
        title: response.view.title,
        submit: response.view.submit,
        close: response.view.close,
        blocks: Array.isArray(response.view.blocks) ? response.view.blocks : [],
        opened_by: user.id,
        trigger_id: payload.trigger_id as string,
        state: { values: {} },
        clear_on_close: false,
        notify_on_close: false,
      });
    } else if (response.response_action === "clear") {
      this.store.views.clear();
    } else {
      this.store.views.delete(view.id);
    }
    await this.flush();
    return ack;
  }

  /** A human opens the app's assistant pane; returns the DM thread to talk in. */
  async startAssistantThread(
    input: { user?: string; context?: Record<string, unknown> } = {},
  ): Promise<{ channel: string; thread_ts: string }> {
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    const dm = this.store.openDm(user.id);
    // Slack roots every assistant thread with a hidden "New chat" message the user owns.
    const root = this.store.addMessage({
      channel: dm.id,
      user: user.id,
      subtype: "assistant_app_thread",
      text: "New chat",
    });
    const threadTs = root.ts;
    if (this.isSubscribed("assistant_thread_started")) {
      await this.track(
        this.hub.send(
          "events_api",
          eventCallback(
            this.store,
            assistantThreadStartedEvent(this.store, dm, user.id, threadTs, input.context),
          ),
        ),
      );
    }
    return { channel: dm.id, thread_ts: threadTs };
  }

  async changeAssistantContext(input: {
    channel: string;
    thread_ts: string;
    context: Record<string, unknown>;
    user?: string;
  }): Promise<void> {
    const user = input.user ? this.user(input.user) : this.defaultHuman();
    const dm = this.resolveChannel(input.channel);
    await this.track(
      this.hub.send(
        "events_api",
        eventCallback(
          this.store,
          assistantThreadContextChangedEvent(
            this.store,
            dm,
            user.id,
            input.thread_ts,
            input.context,
          ),
        ),
      ),
    );
  }

  assistantThread(channel: string, thread_ts: string) {
    return this.store.assistantThreads.get(`${this.resolveChannel(channel).id}:${thread_ts}`) ?? {};
  }

  // ----------------------------------------------------------- queries

  messages(channel: string): SlackMessage[] {
    return [...(this.store.messages.get(this.resolveChannel(channel).id) ?? [])];
  }

  thread(channel: string, ts: string): SlackMessage[] {
    return this.store.replies(this.resolveChannel(channel).id, ts, { limit: 1000 }).items;
  }

  ephemeralMessages(channel?: string): SlackMessage[] {
    const id = channel ? this.resolveChannel(channel).id : undefined;
    return this.store.ephemerals.filter((m) => !id || m.channel === id);
  }

  /** Make the next call(s) to a Web API method fail with a Slack error. */
  injectFault(fault: Fault): void {
    this.faults.push({ ...fault, remaining: fault.times ?? 1 });
  }

  /** Every Socket Mode envelope pushed to the app, with ack status. */
  deliveries(name?: string): DeliveryRecord[] {
    return name ? this.hub.history.filter((d) => d.name === name) : [...this.hub.history];
  }

  apiCalls(method?: string): ApiCall[] {
    return method
      ? this.store.apiCalls.filter((c) => c.method === method)
      : [...this.store.apiCalls];
  }

  private matches(m: SlackMessage, q: MessageQuery): boolean {
    if (m.ephemeral_user && !q.ephemeral) return false;
    if (q.channel && m.channel !== this.resolveChannel(q.channel).id) return false;
    if (q.thread_ts && m.thread_ts !== q.thread_ts && m.ts !== q.thread_ts) return false;
    if (q.from === "bot" && !this.store.isBotUser(m.user)) return false;
    if (q.from === "human" && this.store.isBotUser(m.user)) return false;
    if (q.from && q.from !== "bot" && q.from !== "human" && m.user !== this.user(q.from).id)
      return false;
    if (q.event_type && m.metadata?.event_type !== q.event_type) return false;
    if (typeof q.text === "string" && !m.text.includes(q.text)) return false;
    if (q.text instanceof RegExp && !q.text.test(m.text)) return false;
    return true;
  }

  findMessages(q: MessageQuery): SlackMessage[] {
    const all = [...this.store.messages.values()]
      .flat()
      .concat(q.ephemeral ? this.store.ephemerals : []);
    return all.filter((m) => this.matches(m, q));
  }

  /** Resolve with the first message (existing or future) that matches. */
  waitForMessage(
    q: MessageQuery | ((m: SlackMessage) => boolean),
    opts: { timeoutMs?: number; after?: string } = {},
  ): Promise<SlackMessage> {
    const test = typeof q === "function" ? q : (m: SlackMessage) => this.matches(m, q);
    const after = opts.after ? Number(opts.after) : -1;
    const existing = [...this.store.messages.values()]
      .flat()
      .concat(this.store.ephemerals)
      .find((m) => Number(m.ts) > after && test(m));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          new Error(`timed out after ${opts.timeoutMs ?? 10_000}ms waiting for a matching message`),
        );
      }, opts.timeoutMs ?? 10_000);
      const off = this.store.onChange((c) => {
        if (
          (c.kind === "message.add" || c.kind === "message.update") &&
          Number(c.message.ts) > after &&
          test(c.message)
        ) {
          clearTimeout(timer);
          off();
          resolve(c.message);
        }
      });
    });
  }

  waitForApiCall(
    method: string,
    opts: { timeoutMs?: number; where?: (c: ApiCall) => boolean } = {},
  ): Promise<ApiCall> {
    const found = this.store.apiCalls.find((c) => c.method === method && (opts.where?.(c) ?? true));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, opts.timeoutMs ?? 10_000);
      const off = this.store.onChange((c) => {
        if (c.kind === "api.call" && c.call.method === method && (opts.where?.(c.call) ?? true)) {
          clearTimeout(timer);
          off();
          resolve(c.call);
        }
      });
    });
  }

  waitForConnection(timeoutMs = 15_000): Promise<void> {
    return this.hub.waitForConnection(timeoutMs);
  }

  disconnectSockets(reason?: Parameters<SocketModeHub["disconnectAll"]>[0]): void {
    this.hub.disconnectAll(reason);
  }

  onChange(listener: (change: Change) => void): () => void {
    return this.store.onChange(listener);
  }

  // ------------------------------------------------------------ admin

  private async handleAdmin(req: Request, path: string, url: URL): Promise<Response> {
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const body =
      req.method === "POST"
        ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
        : {};
    try {
      if (path === "state") {
        return json({
          team: this.store.team,
          app: this.store.app,
          bot: { userId: this.store.bot.userId, botId: this.store.bot.botId },
          connections: this.hub.connectionCount,
          users: [...this.store.users.values()],
          channels: [...this.store.channels.values()],
        });
      }
      if (path === "channels" && req.method === "POST")
        return json(this.addChannel(body as unknown as AddChannelInput));
      if (path === "users" && req.method === "POST")
        return json(this.addUser(body as unknown as AddUserInput));
      if (path === "messages" && req.method === "POST") {
        const input = body as unknown as PostMessageInput;
        return json(
          wireMessage(
            await this.postMessage({ ...input, text: this.resolveMentions(input.text ?? "") }),
          ),
        );
      }
      if (path === "messages" && req.method === "GET") {
        const q: MessageQuery = Object.fromEntries(url.searchParams) as MessageQuery;
        return json(this.findMessages(q).map(wireMessage));
      }
      if (path === "commands" && req.method === "POST") {
        const r = await this.slashCommand(body as { command: string });
        return json({ ack: r.ack, response: r.response ? wireMessage(r.response) : undefined });
      }
      if (path === "actions" && req.method === "POST")
        return json(
          await this.clickButton(body as { channel: string; ts: string; action_id: string }),
        );
      if (path === "views/submit" && req.method === "POST")
        return json(
          await this.submitView(body as { values: Record<string, Record<string, unknown>> }),
        );
      if (path === "assistant/start" && req.method === "POST")
        return json(await this.startAssistantThread(body));
      if (path === "reactions" && req.method === "POST") {
        await this.addReaction(body as { channel: string; ts: string; name: string });
        return json({ ok: true });
      }
      if (path === "api-calls")
        return json(this.apiCalls(url.searchParams.get("method") ?? undefined));
      if (path === "disconnect" && req.method === "POST") {
        this.disconnectSockets(body.reason as "refresh_requested" | undefined);
        return json({ ok: true });
      }
      const m = /^channels\/([^/]+)(?:\/threads\/([^/]+))?$/.exec(path);
      if (m) return json((m[2] ? this.thread(m[1]!, m[2]) : this.messages(m[1]!)).map(wireMessage));
      return json({ ok: false, error: "unknown_admin_route" }, 404);
    } catch (e) {
      return json({ ok: false, error: e instanceof SlackApiError ? e.code : String(e) }, 400);
    }
  }
}

function slackError(code: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: code, ...extra });
}

function findButton(
  blocks: unknown[] | undefined,
  actionId: string,
): { block_id?: string; text?: unknown; value?: string; style?: string } | undefined {
  for (const b of (blocks ?? []) as Array<Record<string, unknown>>) {
    const elements = [
      ...(Array.isArray(b.elements) ? (b.elements as Array<Record<string, unknown>>) : []),
      ...(b.accessory ? [b.accessory as Record<string, unknown>] : []),
    ];
    for (const el of elements) {
      if (el.type === "button" && el.action_id === actionId) {
        return {
          block_id: b.block_id as string | undefined,
          text: el.text,
          value: el.value as string | undefined,
          style: el.style as string | undefined,
        };
      }
    }
  }
  return undefined;
}

export { SlackApiError };
