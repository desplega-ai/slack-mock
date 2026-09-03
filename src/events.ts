// Builders for the payloads Slack pushes to apps: Events API callbacks,
// slash commands and interactive payloads. Shapes follow @slack/types.

import { nextTs, nowUnix, slackId } from "./ids.ts";
import { type Store, wireFile, wireMessage } from "./store.ts";
import type { SlackChannel, SlackMessage, SlackUser, SlackView } from "./types.ts";

export const VERIFICATION_TOKEN = "mock-verification-token";

export function eventCallback(
  store: Store,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    token: VERIFICATION_TOKEN,
    team_id: store.team.id,
    context_team_id: store.team.id,
    context_enterprise_id: null,
    api_app_id: store.app.id,
    event,
    type: "event_callback",
    event_id: slackId("Ev", 9),
    event_time: nowUnix(),
    authorizations: [
      {
        enterprise_id: null,
        team_id: store.team.id,
        user_id: store.bot.userId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    is_ext_shared_channel: false,
    event_context: Buffer.from(
      `${store.team.id}:${store.app.id}:${(event.channel as string) ?? ""}`,
    ).toString("base64"),
  };
}

/** The `message` event for a stored message (any subtype). */
export function messageEvent(
  store: Store,
  m: SlackMessage,
  channel: SlackChannel,
): Record<string, unknown> {
  const {
    channel: _c,
    team,
    ...rest
  } = wireMessage(m) as Record<string, unknown> & { team: string };
  const event: Record<string, unknown> = {
    ...rest,
    type: "message",
    channel: m.channel,
    event_ts: m.ts,
    channel_type: store.channelType(channel),
    team,
  };
  if (m.files?.length && !m.subtype) event.subtype = "file_share";
  if (m.files?.length) {
    event.upload = false;
    event.display_as_bot = false;
  }
  return event;
}

export function appMentionEvent(store: Store, m: SlackMessage): Record<string, unknown> {
  const { channel_type: _ct, ...event } = messageEvent(store, m, store.channel(m.channel));
  return { ...event, type: "app_mention" };
}

export function messageChangedEvent(
  store: Store,
  m: SlackMessage,
  previous: SlackMessage,
): Record<string, unknown> {
  const channel = store.channel(m.channel);
  const ts = nextTs();
  return {
    type: "message",
    subtype: "message_changed",
    channel: m.channel,
    channel_type: store.channelType(channel),
    hidden: true,
    ts,
    event_ts: ts,
    message: {
      ...wireMessage(m),
      channel: undefined,
      source_team: store.team.id,
      user_team: store.team.id,
    },
    previous_message: { ...wireMessage(previous), channel: undefined },
  };
}

export function messageDeletedEvent(store: Store, m: SlackMessage): Record<string, unknown> {
  const channel = store.channel(m.channel);
  const ts = nextTs();
  return {
    type: "message",
    subtype: "message_deleted",
    channel: m.channel,
    channel_type: store.channelType(channel),
    hidden: true,
    deleted_ts: m.ts,
    ts,
    event_ts: ts,
    previous_message: { ...wireMessage(m), channel: undefined },
  };
}

export function reactionEvent(
  kind: "reaction_added" | "reaction_removed",
  m: SlackMessage,
  name: string,
  user: string,
): Record<string, unknown> {
  return {
    type: kind,
    user,
    reaction: name,
    item_user: m.user,
    item: { type: "message", channel: m.channel, ts: m.ts },
    event_ts: nextTs(),
  };
}

export function memberJoinedEvent(
  store: Store,
  channel: SlackChannel,
  user: string,
  inviter?: string,
): Record<string, unknown> {
  return {
    type: "member_joined_channel",
    user,
    channel: channel.id,
    channel_type: store.channelType(channel) === "channel" ? "C" : "G",
    team: store.team.id,
    inviter,
    event_ts: nextTs(),
  };
}

export function assistantThreadStartedEvent(
  store: Store,
  dm: SlackChannel,
  user: string,
  threadTs: string,
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "assistant_thread_started",
    assistant_thread: {
      user_id: user,
      context: { team_id: store.team.id, enterprise_id: null, ...context },
      channel_id: dm.id,
      thread_ts: threadTs,
    },
    event_ts: nextTs(),
  };
}

export function assistantThreadContextChangedEvent(
  store: Store,
  dm: SlackChannel,
  user: string,
  threadTs: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "assistant_thread_context_changed",
    assistant_thread: {
      user_id: user,
      context: { team_id: store.team.id, enterprise_id: null, ...context },
      channel_id: dm.id,
      thread_ts: threadTs,
    },
    event_ts: nextTs(),
  };
}

export function slashCommandPayload(
  store: Store,
  input: {
    command: string;
    text: string;
    user: SlackUser;
    channel: SlackChannel;
    responseUrl: string;
    triggerId: string;
  },
): Record<string, unknown> {
  return {
    token: VERIFICATION_TOKEN,
    team_id: store.team.id,
    team_domain: store.team.domain,
    channel_id: input.channel.id,
    channel_name: input.channel.is_im ? "directmessage" : input.channel.name,
    user_id: input.user.id,
    user_name: input.user.name,
    command: input.command,
    text: input.text,
    api_app_id: store.app.id,
    is_enterprise_install: "false",
    response_url: input.responseUrl,
    trigger_id: input.triggerId,
  };
}

export function blockActionsPayload(
  store: Store,
  input: {
    user: SlackUser;
    channel: SlackChannel;
    message: SlackMessage;
    actions: Array<Record<string, unknown>>;
    responseUrl: string;
    triggerId: string;
  },
): Record<string, unknown> {
  return {
    type: "block_actions",
    user: {
      id: input.user.id,
      username: input.user.name,
      name: input.user.name,
      team_id: store.team.id,
    },
    api_app_id: store.app.id,
    token: VERIFICATION_TOKEN,
    container: {
      type: "message",
      message_ts: input.message.ts,
      channel_id: input.channel.id,
      is_ephemeral: !!input.message.ephemeral_user,
      ...(input.message.thread_ts ? { thread_ts: input.message.thread_ts } : {}),
    },
    trigger_id: input.triggerId,
    team: { id: store.team.id, domain: store.team.domain },
    enterprise: null,
    is_enterprise_install: false,
    channel: { id: input.channel.id, name: input.channel.name },
    message: wireMessage(input.message),
    state: { values: {} },
    response_url: input.responseUrl,
    actions: input.actions.map((a) => ({ action_ts: nextTs(), ...a })),
  };
}

export function viewSubmissionPayload(
  store: Store,
  input: {
    user: SlackUser;
    view: SlackView;
    values: Record<string, Record<string, unknown>>;
    triggerId: string;
  },
): Record<string, unknown> {
  const { opened_by: _o, trigger_id: _t, ...view } = input.view;
  return {
    type: "view_submission",
    team: { id: store.team.id, domain: store.team.domain },
    user: {
      id: input.user.id,
      username: input.user.name,
      name: input.user.name,
      team_id: store.team.id,
    },
    api_app_id: store.app.id,
    token: VERIFICATION_TOKEN,
    trigger_id: input.triggerId,
    view: { ...view, state: { values: input.values } },
    response_urls: [],
    is_enterprise_install: false,
    enterprise: null,
  };
}

export { wireFile };
