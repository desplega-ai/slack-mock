// Slack-shaped domain objects stored by the mock. Field names follow the Slack
// Web API so they can be returned verbatim and embedded in event payloads.

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  real_name: string;
  deleted: boolean;
  is_bot: boolean;
  is_admin: boolean;
  is_app_user: boolean;
  tz: string;
  profile: {
    real_name: string;
    display_name: string;
    real_name_normalized: string;
    display_name_normalized: string;
    email?: string;
    image_72?: string;
    team: string;
  };
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_general: boolean;
  created: number;
  creator: string;
  /** Peer user id for DMs. */
  user?: string;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
  /** Not a Slack field on the wire; exposed via conversations.members. */
  members: string[];
}

export interface SlackFile {
  id: string;
  created: number;
  timestamp: number;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  pretty_type: string;
  user: string;
  size: number;
  mode: string;
  is_external: boolean;
  is_public: boolean;
  url_private: string;
  url_private_download: string;
  permalink: string;
  channels: string[];
  /** Raw bytes; stripped before the object is put on the wire. */
  bytes?: Uint8Array;
}

export interface SlackReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackMessage {
  type: "message";
  subtype?: string;
  channel: string;
  team: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  metadata?: { event_type: string; event_payload?: Record<string, unknown> };
  files?: SlackFile[];
  bot_id?: string;
  app_id?: string;
  username?: string;
  icons?: Record<string, string>;
  bot_profile?: { id: string; name: string; app_id: string; team_id: string; deleted: boolean };
  reactions?: SlackReaction[];
  edited?: { user: string; ts: string };
  reply_count?: number;
  reply_users?: string[];
  reply_users_count?: number;
  latest_reply?: string;
  client_msg_id?: string;
  /** Set on messages created by chat.startStream: "in_progress" until chat.stopStream. */
  streaming_state?: string;
  thumb_64?: string;
  /** Mock-only: the user who can see an ephemeral message. Stripped on the wire. */
  ephemeral_user?: string;
}

export interface SlackView {
  id: string;
  team_id: string;
  type: string;
  callback_id?: string;
  private_metadata?: string;
  title?: unknown;
  submit?: unknown;
  close?: unknown;
  blocks: unknown[];
  hash: string;
  external_id?: string;
  /** Mock-only bookkeeping. */
  opened_by: string;
  trigger_id: string;
  state: { values: Record<string, Record<string, unknown>> };
  root_view_id: string;
  app_id: string;
  bot_id: string;
  clear_on_close: boolean;
  notify_on_close: boolean;
}

export interface ApiCall {
  at: string;
  method: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export type Change =
  | { kind: "message.add"; message: SlackMessage }
  | { kind: "message.update"; message: SlackMessage; previous: SlackMessage }
  | { kind: "message.delete"; message: SlackMessage }
  | { kind: "reaction.add"; message: SlackMessage; name: string; user: string }
  | { kind: "reaction.remove"; message: SlackMessage; name: string; user: string }
  | { kind: "channel.add"; channel: SlackChannel }
  | { kind: "channel.update"; channel: SlackChannel }
  | { kind: "member.join"; channel: SlackChannel; user: string; inviter?: string }
  | { kind: "user.add"; user: SlackUser }
  | { kind: "file.add"; file: SlackFile }
  | { kind: "view.open"; view: SlackView }
  | { kind: "view.update"; view: SlackView }
  | { kind: "assistant.status"; channel: string; thread_ts: string; status: string }
  | { kind: "assistant.title"; channel: string; thread_ts: string; title: string }
  | {
      kind: "assistant.prompts";
      channel: string;
      thread_ts: string;
      prompts: unknown[];
      title?: string;
    }
  | { kind: "api.call"; call: ApiCall };
