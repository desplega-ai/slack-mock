// Slack Web API method handlers. Each receives the parsed args and returns the
// `ok: true` body; they throw SlackApiError for `ok: false` responses.

import { type Args, bool, num, str } from "./body.ts";
import { nextTs, nowUnix, slackId } from "./ids.ts";
import type { SocketModeHub } from "./socket-mode.ts";
import { SlackApiError, type Store, wireFile, wireMessage } from "./store.ts";
import type { SlackChannel, SlackFile, SlackMessage } from "./types.ts";

export interface Actor {
  userId: string;
  isBot: boolean;
}

export interface ApiContext {
  store: Store;
  hub: SocketModeHub;
  baseUrl: string;
  wsUrl: string;
  actor: Actor;
  /** Trigger ids issued with interactive payloads, with their expiry. */
  triggerIds: Map<string, number>;
  /** Files created by files.getUploadURLExternal that still await bytes. */
  pendingUploads: Map<string, { name: string; length: number; alt_text?: string; user: string }>;
}

export type Handler = (ctx: ApiContext, args: Args) => Record<string, unknown>;

function required(args: Args, key: string): string {
  const v = str(args, key);
  if (!v)
    throw new SlackApiError("invalid_arguments", {
      response_metadata: { messages: [`[ERROR] missing required field: ${key}`] },
    });
  return v;
}

/** Resolve `channel` args that may be an id, a #name or a user id (opens a DM). */
function resolveChannel(store: Store, raw: string): SlackChannel {
  if (raw.startsWith("#")) {
    const c = store.channelByName(raw);
    if (!c) throw new SlackApiError("channel_not_found");
    return c;
  }
  if (raw.startsWith("U") || raw.startsWith("W")) return store.openDm(raw);
  return store.channel(raw);
}

function requireMember(channel: SlackChannel, actor: Actor): void {
  if (!channel.members.includes(actor.userId)) throw new SlackApiError("not_in_channel");
}

function botFields(ctx: ApiContext): Partial<SlackMessage> {
  if (!ctx.actor.isBot) return {};
  return {
    bot_id: ctx.store.bot.botId,
    app_id: ctx.store.app.id,
    bot_profile: {
      id: ctx.store.bot.botId,
      name: ctx.store.app.name,
      app_id: ctx.store.app.id,
      team_id: ctx.store.team.id,
      deleted: false,
    },
  };
}

function messageContent(
  args: Args,
): Pick<SlackMessage, "text" | "blocks" | "attachments" | "metadata"> {
  const text = str(args, "text") ?? "";
  const blocks = Array.isArray(args.blocks) ? (args.blocks as unknown[]) : undefined;
  const attachments = Array.isArray(args.attachments) ? (args.attachments as unknown[]) : undefined;
  if (!text && !blocks?.length && !attachments?.length) throw new SlackApiError("no_text");
  if (blocks && blocks.length > 50)
    throw new SlackApiError("invalid_blocks", {
      response_metadata: { messages: ["[ERROR] must have at most 50 blocks"] },
    });
  const metadata =
    args.metadata && typeof args.metadata === "object"
      ? (args.metadata as SlackMessage["metadata"])
      : undefined;
  return { text, blocks, attachments, metadata };
}

function channelInfo(store: Store, c: SlackChannel, actor: Actor): Record<string, unknown> {
  const { members, ...rest } = c;
  return {
    ...rest,
    is_member: members.includes(actor.userId),
    num_members: members.length,
    context_team_id: store.team.id,
    shared_team_ids: [store.team.id],
    is_org_shared: false,
    is_shared: false,
    is_ext_shared: false,
    is_pending_ext_shared: false,
    unlinked: 0,
    name_normalized: c.name,
    updated: c.created * 1000,
  };
}

export const handlers: Record<string, Handler> = {
  "auth.test": ({ store, actor }) => {
    const user = store.user(actor.userId);
    return {
      url: `https://${store.team.domain}.slack.com/`,
      team: store.team.name,
      user: user.name,
      team_id: store.team.id,
      user_id: user.id,
      ...(actor.isBot ? { bot_id: store.bot.botId } : {}),
      is_enterprise_install: false,
    };
  },

  "apps.connections.open": ({ hub, wsUrl, store }) => ({
    url: `${wsUrl}/link/?ticket=${hub.issueTicket()}&app_id=${store.app.id}`,
  }),

  "bots.info": ({ store }) => ({
    bot: {
      id: store.bot.botId,
      deleted: false,
      name: store.app.name,
      updated: nowUnix(),
      app_id: store.app.id,
      user_id: store.bot.userId,
      icons: {},
    },
  }),

  "team.info": ({ store }) => ({
    team: {
      id: store.team.id,
      name: store.team.name,
      domain: store.team.domain,
      email_domain: "",
      icon: {},
      is_verified: false,
    },
  }),

  // ------------------------------------------------------------------ chat

  "chat.postMessage": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    requireMember(channel, ctx.actor);
    const threadTs = str(args, "thread_ts");
    const message = ctx.store.addMessage({
      channel: channel.id,
      user: ctx.actor.userId,
      ...messageContent(args),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(bool(args, "reply_broadcast") && threadTs ? { subtype: "thread_broadcast" } : {}),
      ...(str(args, "username") ? { username: str(args, "username") } : {}),
      ...(str(args, "icon_emoji") || str(args, "icon_url")
        ? {
            icons: {
              ...(str(args, "icon_emoji") ? { emoji: str(args, "icon_emoji")! } : {}),
              ...(str(args, "icon_url") ? { image_64: str(args, "icon_url")! } : {}),
            },
          }
        : {}),
      ...botFields(ctx),
    });
    return { channel: channel.id, ts: message.ts, message: wireMessage(message) };
  },

  "chat.postEphemeral": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    const user = required(args, "user");
    ctx.store.user(user);
    const threadTs = str(args, "thread_ts");
    const message = ctx.store.addMessage({
      channel: channel.id,
      user: ctx.actor.userId,
      ephemeral_user: user,
      ...messageContent(args),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...botFields(ctx),
    });
    return { message_ts: message.ts };
  },

  "chat.update": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    const ts = required(args, "ts");
    const existing = ctx.store.message(channel.id, ts);
    if (existing.user !== ctx.actor.userId && !ctx.actor.isBot)
      throw new SlackApiError("cant_update_message");
    const patch: Partial<SlackMessage> = {};
    if (args.text !== undefined) patch.text = str(args, "text") ?? "";
    if (args.blocks !== undefined)
      patch.blocks = Array.isArray(args.blocks) ? (args.blocks as unknown[]) : undefined;
    if (args.attachments !== undefined)
      patch.attachments = Array.isArray(args.attachments)
        ? (args.attachments as unknown[])
        : undefined;
    if (args.metadata !== undefined) patch.metadata = args.metadata as SlackMessage["metadata"];
    if (
      patch.text === "" &&
      !patch.blocks?.length &&
      !patch.attachments?.length &&
      !existing.blocks?.length
    )
      throw new SlackApiError("no_text");
    const message = ctx.store.updateMessage(channel.id, ts, patch, ctx.actor.userId);
    return { channel: channel.id, ts, text: message.text, message: wireMessage(message) };
  },

  "chat.delete": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    const ts = required(args, "ts");
    ctx.store.deleteMessage(channel.id, ts);
    return { channel: channel.id, ts };
  },

  // ------------------------------------------------- chat streaming (markdown)

  "chat.startStream": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    requireMember(channel, ctx.actor);
    const threadTs = str(args, "thread_ts");
    const message = ctx.store.addMessage({
      channel: channel.id,
      user: ctx.actor.userId,
      text: streamText(args),
      streaming_state: "in_progress",
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(str(args, "username") ? { username: str(args, "username") } : {}),
      ...(str(args, "icon_emoji") ? { icons: { emoji: str(args, "icon_emoji")! } } : {}),
      ...botFields(ctx),
    });
    return { channel: channel.id, ts: message.ts };
  },

  "chat.appendStream": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    const ts = required(args, "ts");
    const existing = ctx.store.message(channel.id, ts);
    if (existing.streaming_state !== "in_progress")
      throw new SlackApiError("message_not_in_streaming_state");
    // Streaming appends are not edits: Slack shows no "(edited)" marker for them.
    const message = ctx.store.updateMessage(
      channel.id,
      ts,
      { text: existing.text + streamText(args) },
      ctx.actor.userId,
      { markEdited: false },
    );
    return { channel: channel.id, ts: message.ts };
  },

  "chat.stopStream": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    const ts = required(args, "ts");
    const existing = ctx.store.message(channel.id, ts);
    if (existing.streaming_state !== "in_progress")
      throw new SlackApiError("message_not_in_streaming_state");
    const patch: Partial<SlackMessage> = {
      streaming_state: "completed",
      text: existing.text + streamText(args),
    };
    if (Array.isArray(args.blocks)) patch.blocks = args.blocks as unknown[];
    const message = ctx.store.updateMessage(channel.id, ts, patch, ctx.actor.userId, {
      markEdited: false,
    });
    return { channel: channel.id, ts, message: wireMessage(message) };
  },

  "chat.getPermalink": (ctx, args) => {
    const channel = resolveChannel(ctx.store, required(args, "channel"));
    const ts = required(args, "message_ts");
    ctx.store.message(channel.id, ts);
    return {
      channel: channel.id,
      permalink: `${ctx.baseUrl}/archives/${channel.id}/p${ts.replace(".", "")}`,
    };
  },

  // --------------------------------------------------------- conversations

  "conversations.list": (ctx, args) => {
    const types = new Set((str(args, "types") ?? "public_channel").split(",").map((t) => t.trim()));
    const excludeArchived = bool(args, "exclude_archived") ?? false;
    const all = [...ctx.store.channels.values()].filter((c) => {
      if (excludeArchived && c.is_archived) return false;
      if (c.is_im) return types.has("im");
      if (c.is_mpim) return types.has("mpim");
      if (c.is_private) return types.has("private_channel");
      return types.has("public_channel");
    });
    const limit = num(args, "limit", 100);
    const start = cursorOffset(str(args, "cursor"));
    const slice = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      channels: slice.map((c) => channelInfo(ctx.store, c, ctx.actor)),
      response_metadata: { next_cursor: hasMore ? cursorFor(start + limit) : "" },
    };
  },

  "conversations.info": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    return { channel: channelInfo(ctx.store, channel, ctx.actor) };
  },

  "conversations.create": (ctx, args) => {
    const name = required(args, "name");
    if (!/^[a-z0-9_-]{1,80}$/.test(name)) throw new SlackApiError("invalid_name_specials");
    const channel = ctx.store.addChannel({
      name,
      is_private: bool(args, "is_private") ?? false,
      creator: ctx.actor.userId,
    });
    return { channel: channelInfo(ctx.store, channel, ctx.actor) };
  },

  "conversations.join": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    if (channel.is_private) throw new SlackApiError("method_not_supported_for_channel_type");
    const { alreadyMember } = ctx.store.join(channel.id, ctx.actor.userId);
    return {
      channel: channelInfo(ctx.store, channel, ctx.actor),
      ...(alreadyMember
        ? { warning: "already_in_channel", response_metadata: { warnings: ["already_in_channel"] } }
        : {}),
    };
  },

  "conversations.invite": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    const users = required(args, "users")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    const errors: Array<Record<string, unknown>> = [];
    for (const u of users) {
      if (!ctx.store.users.has(u)) {
        errors.push({ user: u, ok: false, error: "user_not_found" });
        continue;
      }
      const { alreadyMember } = ctx.store.join(channel.id, u, ctx.actor.userId);
      if (alreadyMember) errors.push({ user: u, ok: false, error: "already_in_channel" });
    }
    if (errors.length === users.length)
      throw new SlackApiError(String(errors[0]!.error), { errors });
    return {
      channel: channelInfo(ctx.store, channel, ctx.actor),
      ...(errors.length ? { errors } : {}),
    };
  },

  "conversations.archive": (ctx, args) => {
    ctx.store.archive(required(args, "channel"));
    return {};
  },

  "conversations.members": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    return { members: channel.members, response_metadata: { next_cursor: "" } };
  },

  "conversations.open": (ctx, args) => {
    const users = (str(args, "users") ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (users.length !== 1) throw new SlackApiError("users_list_not_supplied");
    const dm = ctx.store.openDm(users[0]!);
    return { channel: { id: dm.id, is_im: true, user: dm.user, created: dm.created } };
  },

  "conversations.history": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    requireMember(channel, ctx.actor);
    const p = ctx.store.history(channel.id, {
      oldest: str(args, "oldest"),
      latest: str(args, "latest"),
      inclusive: bool(args, "inclusive"),
      limit: num(args, "limit", 100),
      cursor: str(args, "cursor"),
    });
    return {
      messages: p.items.map((m) => historyMessage(m, bool(args, "include_all_metadata"))),
      has_more: p.has_more,
      pin_count: 0,
      response_metadata: { next_cursor: p.next_cursor },
    };
  },

  "conversations.replies": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    requireMember(channel, ctx.actor);
    const ts = required(args, "ts");
    if (!ctx.store.findMessage(channel.id, ts)) throw new SlackApiError("thread_not_found");
    const p = ctx.store.replies(channel.id, ts, {
      oldest: str(args, "oldest"),
      latest: str(args, "latest"),
      inclusive: bool(args, "inclusive"),
      limit: num(args, "limit", 1000),
      cursor: str(args, "cursor"),
    });
    return {
      messages: p.items.map((m) => historyMessage(m, bool(args, "include_all_metadata"))),
      has_more: p.has_more,
      response_metadata: { next_cursor: p.next_cursor },
    };
  },

  // ----------------------------------------------------------------- users

  "users.info": (ctx, args) => ({ user: ctx.store.user(required(args, "user")) }),

  "users.list": (ctx) => ({
    members: [...ctx.store.users.values()],
    response_metadata: { next_cursor: "" },
  }),

  "users.lookupByEmail": (ctx, args) => {
    const user = ctx.store.userByEmail(required(args, "email"));
    if (!user) throw new SlackApiError("users_not_found");
    return { user };
  },

  "users.conversations": (ctx, args) => {
    const user = str(args, "user") ?? ctx.actor.userId;
    const channels = [...ctx.store.channels.values()].filter(
      (c) => c.members.includes(user) && !c.is_im,
    );
    return {
      channels: channels.map((c) => channelInfo(ctx.store, c, ctx.actor)),
      response_metadata: { next_cursor: "" },
    };
  },

  // ------------------------------------------------------------- reactions

  "reactions.add": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    ctx.store.addReaction(
      channel.id,
      required(args, "timestamp"),
      required(args, "name"),
      ctx.actor.userId,
    );
    return {};
  },

  "reactions.remove": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    ctx.store.removeReaction(
      channel.id,
      required(args, "timestamp"),
      required(args, "name"),
      ctx.actor.userId,
    );
    return {};
  },

  "reactions.get": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    const message = ctx.store.message(channel.id, required(args, "timestamp"));
    return { type: "message", channel: channel.id, message: wireMessage(message) };
  },

  // ----------------------------------------------------------------- files

  "files.info": (ctx, args) => {
    const file = ctx.store.file(required(args, "file"));
    return { file: wireFile(file), comments: [], response_metadata: { next_cursor: "" } };
  },

  "files.getUploadURLExternal": (ctx, args) => {
    const filename = required(args, "filename");
    const length = num(args, "length", -1);
    if (length < 0)
      throw new SlackApiError("invalid_arguments", {
        response_metadata: { messages: ["[ERROR] missing required field: length"] },
      });
    const id = slackId("F");
    ctx.pendingUploads.set(id, {
      name: filename,
      length,
      alt_text: str(args, "alt_text"),
      user: ctx.actor.userId,
    });
    return { upload_url: `${ctx.baseUrl}/upload/v1/${id}`, file_id: id };
  },

  "files.completeUploadExternal": (ctx, args) => {
    const list = Array.isArray(args.files)
      ? (args.files as Array<{ id: string; title?: string }>)
      : [];
    if (list.length === 0)
      throw new SlackApiError("invalid_arguments", {
        response_metadata: { messages: ["[ERROR] missing required field: files"] },
      });
    const files: SlackFile[] = list.map(({ id, title }) => {
      const f = ctx.store.file(id);
      if (title) f.title = title;
      return f;
    });
    const channelId = str(args, "channel_id");
    if (channelId) {
      const channel = ctx.store.channel(channelId);
      requireMember(channel, ctx.actor);
      for (const f of files) if (!f.channels.includes(channel.id)) f.channels.push(channel.id);
      const threadTs = str(args, "thread_ts");
      ctx.store.addMessage({
        channel: channel.id,
        user: ctx.actor.userId,
        subtype: "file_share",
        text: str(args, "initial_comment") ?? "",
        files,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...botFields(ctx),
      });
    }
    return { files: files.map(wireFile) };
  },

  "files.delete": (ctx, args) => {
    ctx.store.file(required(args, "file"));
    ctx.store.files.delete(required(args, "file"));
    return {};
  },

  // ----------------------------------------------------------------- views

  "views.open": (ctx, args) => {
    const triggerId = required(args, "trigger_id");
    const expires = ctx.triggerIds.get(triggerId);
    if (expires === undefined) throw new SlackApiError("invalid_trigger_id");
    ctx.triggerIds.delete(triggerId);
    if (Date.now() > expires) throw new SlackApiError("expired_trigger_id");
    const view = viewArg(args);
    if (view.type !== "modal")
      throw new SlackApiError("invalid_arguments", {
        response_metadata: { messages: ["[ERROR] view type must be modal"] },
      });
    const stored = ctx.store.openView({
      type: "modal",
      callback_id: str(view, "callback_id"),
      private_metadata: str(view, "private_metadata") ?? "",
      title: view.title,
      submit: view.submit,
      close: view.close,
      blocks: Array.isArray(view.blocks) ? view.blocks : [],
      external_id: str(view, "external_id"),
      opened_by: "",
      trigger_id: triggerId,
      state: { values: {} },
      clear_on_close: bool(view, "clear_on_close") ?? false,
      notify_on_close: bool(view, "notify_on_close") ?? false,
    });
    return { view: publicView(stored) };
  },

  "views.update": (ctx, args) => {
    const id = required(args, "view_id");
    const existing = ctx.store.views.get(id);
    if (!existing) throw new SlackApiError("not_found");
    const view = viewArg(args);
    Object.assign(existing, {
      callback_id: str(view, "callback_id") ?? existing.callback_id,
      private_metadata: str(view, "private_metadata") ?? existing.private_metadata,
      title: view.title ?? existing.title,
      submit: view.submit ?? existing.submit,
      close: view.close ?? existing.close,
      blocks: Array.isArray(view.blocks) ? view.blocks : existing.blocks,
      hash: `${nowUnix()}.${slackId("", 6).toLowerCase()}`,
    });
    ctx.store.onChangeEmit({ kind: "view.update", view: existing });
    return { view: publicView(existing) };
  },

  "views.push": (ctx, args) => handlers["views.open"]!(ctx, args),

  // ------------------------------------------------------------- assistant

  "assistant.threads.setStatus": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel_id"));
    const threadTs = required(args, "thread_ts");
    const t = ctx.store.assistantThread(channel.id, threadTs);
    t.status = str(args, "status") ?? "";
    ctx.store.onChangeEmit({
      kind: "assistant.status",
      channel: channel.id,
      thread_ts: threadTs,
      status: t.status,
    });
    return {};
  },

  "assistant.threads.setTitle": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel_id"));
    const threadTs = required(args, "thread_ts");
    const t = ctx.store.assistantThread(channel.id, threadTs);
    t.title = required(args, "title");
    ctx.store.onChangeEmit({
      kind: "assistant.title",
      channel: channel.id,
      thread_ts: threadTs,
      title: t.title,
    });
    return {};
  },

  "assistant.threads.setSuggestedPrompts": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel_id"));
    const threadTs = required(args, "thread_ts");
    const t = ctx.store.assistantThread(channel.id, threadTs);
    t.prompts = Array.isArray(args.prompts) ? (args.prompts as unknown[]) : [];
    t.promptsTitle = str(args, "title");
    ctx.store.onChangeEmit({
      kind: "assistant.prompts",
      channel: channel.id,
      thread_ts: threadTs,
      prompts: t.prompts,
      title: t.promptsTitle,
    });
    return {};
  },

  // ------------------------------------------------------------------ pins

  "pins.add": (ctx, args) => {
    const channel = ctx.store.channel(required(args, "channel"));
    ctx.store.message(channel.id, required(args, "timestamp"));
    return {};
  },
};

/** Text for a streaming call: markdown_text or the joined `chunks`. */
function streamText(args: Args): string {
  const md = str(args, "markdown_text");
  if (md) return md;
  const chunks = Array.isArray(args.chunks) ? (args.chunks as Array<Record<string, unknown>>) : [];
  return chunks
    .map((c) =>
      typeof c.text === "string"
        ? c.text
        : typeof c.markdown_text === "string"
          ? c.markdown_text
          : "",
    )
    .join("");
}

/** Slack only returns message metadata from history/replies when include_all_metadata is set. */
function historyMessage(
  m: SlackMessage,
  includeMetadata: boolean | undefined,
): Record<string, unknown> {
  const wire = wireMessage(m);
  if (!includeMetadata) delete wire.metadata;
  return wire;
}

function viewArg(args: Args): Record<string, unknown> {
  const v = args.view;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      throw new SlackApiError("invalid_arguments", {
        response_metadata: { messages: ["[ERROR] view must be valid JSON"] },
      });
    }
  }
  if (v && typeof v === "object") return v as Record<string, unknown>;
  throw new SlackApiError("invalid_arguments", {
    response_metadata: { messages: ["[ERROR] missing required field: view"] },
  });
}

function publicView(view: import("./types.ts").SlackView): Record<string, unknown> {
  const { opened_by: _o, trigger_id: _t, ...rest } = view;
  return rest;
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  return (
    Number.parseInt(Buffer.from(cursor, "base64").toString("utf8").replace("offset:", ""), 10) || 0
  );
}

function cursorFor(offset: number): string {
  return Buffer.from(`offset:${offset}`).toString("base64");
}

export function newTriggerId(): string {
  return `${nowUnix()}${Math.floor(Math.random() * 1e6)}.${slackId("", 10).toLowerCase()}.${nextTs().replace(".", "")}`;
}
