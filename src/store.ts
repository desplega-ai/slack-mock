import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nextTs, nowUnix, slackId } from "./ids.ts";
import type {
  ApiCall,
  Change,
  SlackChannel,
  SlackFile,
  SlackMessage,
  SlackReaction,
  SlackUser,
  SlackView,
} from "./types.ts";

export class SlackApiError extends Error {
  constructor(
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface StoreOptions {
  /** Append every change as one JSON line to this file and replay it on start. */
  dataFile?: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  appId?: string;
  appName?: string;
  botUserId?: string;
  botId?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
}

export interface AddUserInput {
  id?: string;
  name: string;
  real_name?: string;
  email?: string;
  is_admin?: boolean;
  is_bot?: boolean;
  tz?: string;
}

export interface AddChannelInput {
  id?: string;
  name: string;
  is_private?: boolean;
  members?: string[];
  creator?: string;
  topic?: string;
  purpose?: string;
}

export interface HistoryQuery {
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  has_more: boolean;
  next_cursor: string;
}

/** In-memory Slack workspace with an optional append-only JSONL journal. */
export class Store {
  readonly team: { id: string; name: string; domain: string };
  readonly app: { id: string; name: string };
  readonly bot: {
    userId: string;
    botId: string;
    token: string;
    appToken: string;
    userToken?: string;
  };
  readonly users = new Map<string, SlackUser>();
  readonly channels = new Map<string, SlackChannel>();
  readonly messages = new Map<string, SlackMessage[]>();
  readonly files = new Map<string, SlackFile>();
  readonly views = new Map<string, SlackView>();
  /** Ephemeral messages (chat.postEphemeral, command responses). Not part of history. */
  readonly ephemerals: SlackMessage[] = [];
  readonly apiCalls: ApiCall[] = [];
  readonly assistantThreads = new Map<
    string,
    { status?: string; title?: string; prompts?: unknown[]; promptsTitle?: string }
  >();
  private listeners = new Set<(change: Change) => void>();
  private dataFile?: string;
  private replaying = false;

  constructor(opts: StoreOptions = {}) {
    this.team = {
      id: opts.teamId ?? "T0MOCK0000",
      name: opts.teamName ?? "Mock Workspace",
      domain: opts.teamDomain ?? "mock",
    };
    this.app = { id: opts.appId ?? "A0MOCK0000", name: opts.appName ?? "mock-bot" };
    this.bot = {
      userId: opts.botUserId ?? "U0BOT00000",
      botId: opts.botId ?? "B0BOT00000",
      token: opts.botToken ?? "xoxb-mock-bot-token",
      appToken: opts.appToken ?? "xapp-mock-app-token",
      userToken: opts.userToken,
    };
    this.dataFile = opts.dataFile;
    if (this.dataFile && existsSync(this.dataFile)) this.replay(this.dataFile);
    if (!this.users.has(this.bot.userId)) {
      this.addUser({
        id: this.bot.userId,
        name: this.app.name,
        real_name: this.app.name,
        is_bot: true,
      });
    }
  }

  // ---------------------------------------------------------------- events

  onChange(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit a change that is not produced by a store mutation (e.g. assistant status). */
  onChangeEmit(change: Change): void {
    this.emit(change);
  }

  private emit(change: Change): void {
    if (this.dataFile && !this.replaying && change.kind !== "api.call") {
      appendFileSync(
        this.dataFile,
        `${JSON.stringify({ at: new Date().toISOString(), ...stripBytes(change) })}\n`,
      );
    }
    for (const l of this.listeners) l(change);
  }

  private replay(file: string): void {
    this.replaying = true;
    try {
      let lineNo = 0;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        lineNo += 1;
        if (!line.trim()) continue;
        try {
          this.applyReplayed(JSON.parse(line) as Change);
        } catch (e) {
          console.warn(
            `[slack-mock] skipping corrupt journal line ${lineNo} in ${file}: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    } finally {
      this.replaying = false;
    }
  }

  private applyReplayed(change: Change): void {
    switch (change.kind) {
      case "user.add":
        this.users.set(change.user.id, change.user);
        break;
      case "channel.add":
      case "channel.update":
        this.channels.set(change.channel.id, change.channel);
        break;
      case "member.join": {
        const c = this.channels.get(change.channel.id);
        if (c && !c.members.includes(change.user)) c.members.push(change.user);
        break;
      }
      case "message.add":
        this.insertMessage(change.message);
        break;
      case "message.update":
      case "reaction.add":
      case "reaction.remove": {
        const list = this.messages.get(change.message.channel);
        const i = list?.findIndex((m) => m.ts === change.message.ts) ?? -1;
        if (list && i >= 0) list[i] = change.message;
        break;
      }
      case "message.delete": {
        const list = this.messages.get(change.message.channel);
        const i = list?.findIndex((m) => m.ts === change.message.ts) ?? -1;
        if (list && i >= 0) list.splice(i, 1);
        break;
      }
      case "file.add":
        this.files.set(change.file.id, change.file);
        break;
      default:
        break;
    }
  }

  // ----------------------------------------------------------------- users

  addUser(input: AddUserInput): SlackUser {
    const id = input.id ?? slackId("U");
    const realName = input.real_name ?? input.name;
    const user: SlackUser = {
      id,
      team_id: this.team.id,
      name: input.name,
      real_name: realName,
      deleted: false,
      is_bot: input.is_bot ?? false,
      is_admin: input.is_admin ?? false,
      is_app_user: false,
      tz: input.tz ?? "UTC",
      profile: {
        real_name: realName,
        display_name: input.name,
        real_name_normalized: realName,
        display_name_normalized: input.name,
        email: input.email,
        team: this.team.id,
      },
    };
    this.users.set(id, user);
    this.emit({ kind: "user.add", user });
    return user;
  }

  user(id: string): SlackUser {
    const u = this.users.get(id);
    if (!u) throw new SlackApiError("user_not_found");
    return u;
  }

  userByEmail(email: string): SlackUser | undefined {
    for (const u of this.users.values()) if (u.profile.email === email) return u;
    return undefined;
  }

  isBotUser(userId: string | undefined): boolean {
    return userId === this.bot.userId;
  }

  // -------------------------------------------------------------- channels

  addChannel(input: AddChannelInput): SlackChannel {
    const name = input.name.replace(/^#/, "");
    for (const c of this.channels.values()) {
      if (c.name === name && !c.is_im) throw new SlackApiError("name_taken");
    }
    const id = input.id ?? slackId(input.is_private ? "G" : "C");
    const creator = input.creator ?? this.bot.userId;
    const members = [...new Set([creator, ...(input.members ?? [])])];
    const channel: SlackChannel = {
      id,
      name,
      is_channel: !input.is_private,
      is_group: !!input.is_private,
      is_im: false,
      is_mpim: false,
      is_private: !!input.is_private,
      is_archived: false,
      is_general: name === "general",
      created: nowUnix(),
      creator,
      topic: { value: input.topic ?? "", creator, last_set: 0 },
      purpose: { value: input.purpose ?? "", creator, last_set: 0 },
      members,
    };
    this.channels.set(id, channel);
    this.messages.set(id, []);
    this.emit({ kind: "channel.add", channel });
    return channel;
  }

  /** Direct message channel between the bot and a user (created on demand). */
  openDm(userId: string): SlackChannel {
    this.user(userId);
    for (const c of this.channels.values()) if (c.is_im && c.user === userId) return c;
    const id = slackId("D");
    const channel: SlackChannel = {
      id,
      name: id,
      is_channel: false,
      is_group: false,
      is_im: true,
      is_mpim: false,
      is_private: true,
      is_archived: false,
      is_general: false,
      created: nowUnix(),
      creator: userId,
      user: userId,
      topic: { value: "", creator: "", last_set: 0 },
      purpose: { value: "", creator: "", last_set: 0 },
      members: [userId, this.bot.userId],
    };
    this.channels.set(id, channel);
    this.messages.set(id, []);
    this.emit({ kind: "channel.add", channel });
    return channel;
  }

  channel(id: string): SlackChannel {
    const c = this.channels.get(id);
    if (!c) throw new SlackApiError("channel_not_found");
    return c;
  }

  channelByName(name: string): SlackChannel | undefined {
    const n = name.replace(/^#/, "");
    for (const c of this.channels.values()) if (c.name === n) return c;
    return undefined;
  }

  channelType(c: SlackChannel): "channel" | "group" | "im" | "mpim" {
    if (c.is_im) return "im";
    if (c.is_mpim) return "mpim";
    if (c.is_private) return "group";
    return "channel";
  }

  join(channelId: string, userId: string, inviter?: string): { alreadyMember: boolean } {
    const channel = this.channel(channelId);
    if (channel.is_archived) throw new SlackApiError("is_archived");
    if (channel.members.includes(userId)) return { alreadyMember: true };
    channel.members.push(userId);
    this.emit({ kind: "member.join", channel, user: userId, inviter });
    return { alreadyMember: false };
  }

  archive(channelId: string): void {
    const channel = this.channel(channelId);
    if (channel.is_archived) throw new SlackApiError("already_archived");
    if (channel.is_general) throw new SlackApiError("cant_archive_general");
    channel.is_archived = true;
    this.emit({ kind: "channel.update", channel });
  }

  // -------------------------------------------------------------- messages

  private insertMessage(message: SlackMessage): void {
    const list = this.messages.get(message.channel) ?? [];
    this.messages.set(message.channel, list);
    let i = list.length;
    while (i > 0 && Number(list[i - 1]!.ts) > Number(message.ts)) i--;
    list.splice(i, 0, message);
    if (message.thread_ts && message.thread_ts !== message.ts) {
      const parent = this.findMessage(message.channel, message.thread_ts);
      if (parent) {
        parent.reply_count = (parent.reply_count ?? 0) + 1;
        const users = new Set(parent.reply_users ?? []);
        if (message.user) users.add(message.user);
        parent.reply_users = [...users];
        parent.reply_users_count = users.size;
        parent.latest_reply = message.ts;
        if (parent.user) message.parent_user_id = parent.user;
      }
    }
  }

  findMessage(channelId: string, ts: string): SlackMessage | undefined {
    return this.messages.get(channelId)?.find((m) => m.ts === ts);
  }

  /** A message by ts, including ephemeral ones (used by response_url handling). */
  findAnyMessage(channelId: string, ts: string): SlackMessage | undefined {
    return (
      this.findMessage(channelId, ts) ??
      this.ephemerals.find((m) => m.channel === channelId && m.ts === ts)
    );
  }

  /** Replace the content of an ephemeral message in place (no event, like Slack). */
  updateEphemeral(channelId: string, ts: string, patch: Partial<SlackMessage>): SlackMessage {
    const m = this.ephemerals.find((x) => x.channel === channelId && x.ts === ts);
    if (!m) throw new SlackApiError("message_not_found");
    Object.assign(m, patch);
    return m;
  }

  deleteEphemeral(channelId: string, ts: string): void {
    const i = this.ephemerals.findIndex((x) => x.channel === channelId && x.ts === ts);
    if (i < 0) throw new SlackApiError("message_not_found");
    this.ephemerals.splice(i, 1);
  }

  message(channelId: string, ts: string): SlackMessage {
    const m = this.findMessage(channelId, ts);
    if (!m) throw new SlackApiError("message_not_found");
    return m;
  }

  addMessage(input: Omit<SlackMessage, "type" | "team" | "ts"> & { ts?: string }): SlackMessage {
    const channel = this.channel(input.channel);
    if (channel.is_archived) throw new SlackApiError("is_archived");
    if (input.thread_ts && !this.findMessage(input.channel, input.thread_ts)) {
      throw new SlackApiError("thread_not_found");
    }
    const message: SlackMessage = {
      type: "message",
      team: this.team.id,
      ts: input.ts ?? nextTs(),
      ...input,
    };
    if (message.ephemeral_user) this.ephemerals.push(message);
    else this.insertMessage(message);
    this.emit({ kind: "message.add", message });
    return message;
  }

  updateMessage(
    channelId: string,
    ts: string,
    patch: Partial<SlackMessage>,
    editor: string,
    opts: { markEdited?: boolean } = {},
  ): SlackMessage {
    const message = this.message(channelId, ts);
    const previous = structuredClone(message);
    Object.assign(
      message,
      patch,
      opts.markEdited === false ? {} : { edited: { user: editor, ts: nextTs() } },
    );
    this.emit({ kind: "message.update", message, previous });
    return message;
  }

  deleteMessage(channelId: string, ts: string): SlackMessage {
    const list = this.messages.get(channelId);
    const i = list?.findIndex((m) => m.ts === ts) ?? -1;
    if (!list || i < 0) throw new SlackApiError("message_not_found");
    const [message] = list.splice(i, 1);
    if (message!.thread_ts && message!.thread_ts !== ts) {
      const parent = this.findMessage(channelId, message!.thread_ts);
      if (parent?.reply_count) parent.reply_count -= 1;
    }
    this.emit({ kind: "message.delete", message: message! });
    return message!;
  }

  addReaction(channelId: string, ts: string, name: string, userId: string): SlackMessage {
    const message = this.message(channelId, ts);
    message.reactions ??= [];
    let reaction: SlackReaction | undefined = message.reactions.find((r) => r.name === name);
    if (reaction?.users.includes(userId)) throw new SlackApiError("already_reacted");
    if (!reaction) {
      reaction = { name, users: [], count: 0 };
      message.reactions.push(reaction);
    }
    reaction.users.push(userId);
    reaction.count = reaction.users.length;
    this.emit({ kind: "reaction.add", message, name, user: userId });
    return message;
  }

  removeReaction(channelId: string, ts: string, name: string, userId: string): SlackMessage {
    const message = this.message(channelId, ts);
    const reaction = message.reactions?.find((r) => r.name === name);
    if (!reaction?.users.includes(userId)) throw new SlackApiError("no_reaction");
    reaction.users = reaction.users.filter((u) => u !== userId);
    reaction.count = reaction.users.length;
    message.reactions = message.reactions!.filter((r) => r.count > 0);
    if (message.reactions.length === 0) message.reactions = undefined;
    this.emit({ kind: "reaction.remove", message, name, user: userId });
    return message;
  }

  /** Top-level messages of a channel (thread replies excluded, like conversations.history). */
  history(channelId: string, q: HistoryQuery = {}): Page<SlackMessage> {
    this.channel(channelId);
    const all = (this.messages.get(channelId) ?? []).filter(
      (m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast",
    );
    return paginate(all, q);
  }

  /** Parent plus replies, oldest first (like conversations.replies). */
  replies(channelId: string, threadTs: string, q: HistoryQuery = {}): Page<SlackMessage> {
    const parent = this.message(channelId, threadTs);
    const all = [
      parent,
      ...(this.messages.get(channelId) ?? []).filter(
        (m) => m.thread_ts === threadTs && m.ts !== threadTs,
      ),
    ];
    return paginate(all, q);
  }

  // ----------------------------------------------------------------- files

  addFile(input: {
    id?: string;
    name: string;
    title?: string;
    mimetype?: string;
    user: string;
    bytes: Uint8Array;
    baseUrl: string;
  }): SlackFile {
    const id = input.id ?? slackId("F");
    const ext = input.name.includes(".") ? input.name.split(".").pop()!.toLowerCase() : "";
    const mimetype = input.mimetype ?? guessMime(ext);
    const now = nowUnix();
    const file: SlackFile = {
      id,
      created: now,
      timestamp: now,
      name: input.name,
      title: input.title ?? input.name,
      mimetype,
      filetype: ext || "binary",
      pretty_type: ext ? ext.toUpperCase() : "Binary",
      user: input.user,
      size: input.bytes.byteLength,
      mode: "hosted",
      is_external: false,
      is_public: false,
      url_private: `${input.baseUrl}/files-pri/${this.team.id}-${id}/${encodeURIComponent(input.name)}`,
      url_private_download: `${input.baseUrl}/files-pri/${this.team.id}-${id}/download/${encodeURIComponent(input.name)}`,
      permalink: `${input.baseUrl}/files/${input.user}/${id}/${encodeURIComponent(input.name)}`,
      channels: [],
      bytes: input.bytes,
    };
    if (mimetype.startsWith("image/")) {
      const thumbs = file as unknown as Record<string, string>;
      for (const size of [64, 80, 160, 360, 480]) thumbs[`thumb_${size}`] = file.url_private;
    }
    this.files.set(id, file);
    this.emit({ kind: "file.add", file });
    return file;
  }

  file(id: string): SlackFile {
    const f = this.files.get(id);
    if (!f) throw new SlackApiError("file_not_found");
    return f;
  }

  // ----------------------------------------------------------------- views

  openView(
    view: Omit<SlackView, "id" | "hash" | "root_view_id" | "team_id" | "app_id" | "bot_id"> & {
      id?: string;
    },
  ): SlackView {
    const id = view.id ?? slackId("V");
    const full: SlackView = {
      ...view,
      id,
      team_id: this.team.id,
      app_id: this.app.id,
      bot_id: this.bot.botId,
      hash: `${nowUnix()}.${slackId("", 6).toLowerCase()}`,
      root_view_id: id,
    };
    this.views.set(id, full);
    this.emit({ kind: "view.open", view: full });
    return full;
  }

  // ------------------------------------------------------------- api calls

  recordApiCall(call: ApiCall): void {
    this.apiCalls.push(call);
    this.emit({ kind: "api.call", call });
  }

  assistantThread(channel: string, threadTs: string) {
    const key = `${channel}:${threadTs}`;
    let t = this.assistantThreads.get(key);
    if (!t) {
      t = {};
      this.assistantThreads.set(key, t);
    }
    return t;
  }
}

function paginate<T extends { ts: string }>(all: T[], q: HistoryQuery): Page<T> {
  let items = all;
  if (q.oldest)
    items = items.filter((m) =>
      q.inclusive ? Number(m.ts) >= Number(q.oldest) : Number(m.ts) > Number(q.oldest),
    );
  if (q.latest)
    items = items.filter((m) =>
      q.inclusive ? Number(m.ts) <= Number(q.latest) : Number(m.ts) < Number(q.latest),
    );
  const start = q.cursor
    ? Number.parseInt(
        Buffer.from(q.cursor, "base64").toString("utf8").replace("offset:", ""),
        10,
      ) || 0
    : 0;
  const limit = Math.max(1, Math.min(q.limit ?? 100, 1000));
  const page = items.slice(start, start + limit);
  const has_more = start + limit < items.length;
  return {
    items: page,
    has_more,
    next_cursor: has_more ? Buffer.from(`offset:${start + limit}`).toString("base64") : "",
  };
}

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain",
    md: "text/markdown",
    log: "text/plain",
    json: "application/json",
    csv: "text/csv",
    pdf: "application/pdf",
    html: "text/html",
    zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Public (wire) form of a message: mock-only fields removed, file bytes dropped. */
export function wireMessage(m: SlackMessage): Record<string, unknown> {
  const { ephemeral_user: _e, ...rest } = m;
  if (rest.files) rest.files = rest.files.map(wireFile);
  return rest;
}

export function wireFile(f: SlackFile): SlackFile {
  const { bytes: _b, ...rest } = f;
  return rest;
}

function stripBytes(change: Change): Change {
  if (change.kind === "file.add") return { ...change, file: wireFile(change.file) };
  if ("message" in change && change.message.files) {
    return {
      ...change,
      message: { ...change.message, files: change.message.files.map(wireFile) },
    } as Change;
  }
  return change;
}

export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
