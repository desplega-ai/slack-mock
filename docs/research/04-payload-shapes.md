# R4 — Exact wire shapes from installed `@slack/*` type packages

Scope: extracted field-level shapes (name, type, optional?) directly from the `.d.ts` files installed under
`/Users/taras/Documents/code/agent-swarm/node_modules/@slack/{types,web-api,bolt,socket-mode}`, so the mock's
payload builders and Web API responses match the real wire contract byte-for-byte on the fields that matter.

Versions installed (from `agent-swarm/package.json` / node_modules):
- `@slack/bolt` 4.6.0
- `@slack/socket-mode` 2.0.5
- `@slack/web-api` 7.13.0
- `@slack/types` (transitive dep of the above; installed at `agent-swarm/node_modules/@slack/types`)

All evidence below cites absolute file paths + line numbers under `agent-swarm/node_modules/@slack/...`. No file
under `/Users/taras/Documents/code/agent-swarm` was modified.

Cross-reference: real call-sites in agent-swarm confirming which of these shapes are actually exercised are listed
in **Appendix C**.

---

## ID and timestamp formats (confirmed by evidence)

Slack IDs are opaque strings but follow a stable prefix convention used throughout the type files below:

| Prefix | Entity | Example field it appears in |
|---|---|---|
| `U...` | User | `GenericMessageEvent.user`, `ReactionAddedEvent.user` |
| `B...` | Bot | `BotMessageEvent.bot_id`, `BotProfile.id` |
| `C...` | Public channel | `GenericMessageEvent.channel` |
| `D...` | DM (im) | `channel` when `channel_type: 'im'` |
| `G...` | Private channel / MPIM (legacy "group") | `channel` when `channel_type: 'group'`/`'mpim'` |
| `F...` | File | `File.id` (message.d.ts:247), `UploadedFile.id` (bolt view/index.d.ts:125) |
| `T...` | Team/workspace | `EnvelopedEvent.team_id` (bolt events/index.d.ts:44) |
| `A...` | App (api_app_id) | `EnvelopedEvent.api_app_id` (bolt events/index.d.ts:46) — Slack calls this `api_app_id`; format is `A...` |
| `Ev...` | Event ID | `EnvelopedEvent.event_id` (bolt events/index.d.ts:49) |
| `E...` | Enterprise ID | `Authorization.enterprise_id` (bolt events/index.d.ts:55) |

**`ts` format**: dotted decimal string `"<10-digit-seconds>.<6-digit-microseconds>"`, e.g. `"1700000000.123456"`.
Confirmed both by every `ts?: string` / `ts: string` field across the type files (never `number`) and by
agent-swarm's own round-trip parser:

```
/Users/taras/Documents/code/agent-swarm/src/slack/message-text.ts:197
  if (/^\d{6,}\.\d{1,}$/.test(trimmed)) return trimmed; // already dotted
/Users/taras/Documents/code/agent-swarm/src/slack/message-text.ts:201
  const m = trimmed.match(/p?(\d{10})(\d{6})(?:\D|$)/);
```
This is also the value bolt/`ChatDeleteArguments`/`ChatUpdateArguments` require as `ts`
(`agent-swarm/node_modules/@slack/web-api/dist/types/request/chat.d.ts:9-11`, `:147`).

`thread_ts` is the same dotted format; a message is a thread root when its own `ts === thread_ts` is NOT required
by Slack (a root just omits `thread_ts`, or some events include it pointing at itself) — the mock should treat
"no thread_ts" as root and "thread_ts present" as a reply.

---

## kind=event

### `GenericMessageEvent` (plain user message, `subtype: undefined`)
Source: `@slack/types/dist/events/message.d.ts:7-37`

```
type: 'message'                              // literal
subtype: undefined                           // literal — must be absent/undefined for a plain message
event_ts: string                             // required
team?: string
channel: string                              // required — C.../D.../G...
user: string                                 // required — U...
bot_id?: string
bot_profile?: BotProfile
text?: string
ts: string                                   // required — dotted ts, this message's own id
thread_ts?: string
channel_type: 'channel'|'group'|'im'|'mpim'|'app_home'   // required
attachments?: MessageAttachment[]
blocks?: (KnownBlock | Block)[]
files?: File[]                               // see "File (event, internal)" below
edited?: { user: string; ts: string }
client_msg_id?: string
parent_user_id?: string
is_starred?: boolean
pinned_to?: string[]
reactions?: { name: string; count: number; users: string[] }[]
assistant_thread?: Record<string, unknown>
```
**Practically required for a bot to work**: `type`, `channel`, `user`, `ts`, `channel_type`, `event_ts`. `text` is
optional in the type but the mock should always populate it for normal messages since agent-swarm reads it.

### `BotMessageEvent` (`subtype: 'bot_message'`)
Source: `message.d.ts:38-60`
```
type: 'message'
subtype: 'bot_message'
event_ts: string
channel: string
channel_type: ChannelTypes
streaming_state?: 'in_progress'|'completed'|'errored'
ts: string
text: string                                 // required (not optional, unlike GenericMessageEvent.text)
bot_id: string                               // required — B...
username?: string
icons?: { [size: string]: string }
user?: string
attachments?: MessageAttachment[]
blocks?: (KnownBlock | Block)[]
edited?: { user: string; ts: string }
thread_ts?: string
```
Required: `type`, `subtype`, `channel`, `ts`, `text`, `bot_id`, `channel_type`.

### `message_changed` → `MessageChangedEvent`
Source: `message.d.ts:189-199`
```
type: 'message'
subtype: 'message_changed'
event_ts: string
hidden: true                                 // literal true, always present
channel: string
channel_type: ChannelTypes
ts: string                                   // ts of the *change* event itself
message: MessageEvent                        // the new/current message body (has its own .ts = original msg ts)
previous_message: MessageEvent                // the prior message body
```
Note: `message` and `previous_message` are each a full `MessageEvent` (union of all message subtypes) — for the
mock, populate them as `GenericMessageEvent`-shaped objects with the edited/original text respectively.

### `message_deleted` → `MessageDeletedEvent`
Source: `message.d.ts:200-210`
```
type: 'message'
subtype: 'message_deleted'
event_ts: string
hidden: true
channel: string
channel_type: ChannelTypes
ts: string                                   // ts of the deletion event
deleted_ts: string                           // ts of the message that was deleted
previous_message: MessageEvent               // the message as it existed before deletion
```

### `file_share` → `FileShareMessageEvent`
Source: `message.d.ts:161-178`
```
type: 'message'
subtype: 'file_share'
text: string                                 // required
attachments?: MessageAttachment[]
blocks?: (KnownBlock | Block)[]
files?: File[]
upload?: boolean
display_as_bot?: boolean
x_files?: string[]
user: string                                 // required
parent_user_id?: string
ts: string                                   // required
thread_ts?: string
channel: string                              // required
channel_type: ChannelTypes                   // required
event_ts: string                             // required
```

### `thread_broadcast` → `ThreadBroadcastMessageEvent`
Source: `message.d.ts:225-245`
```
type: 'message'
subtype: 'thread_broadcast'
event_ts: string
text: string
attachments?: MessageAttachment[]
blocks?: (KnownBlock | Block)[]
user: string
ts: string
thread_ts?: string
root: (GenericMessageEvent | BotMessageEvent) & {
    thread_ts: string
    reply_count: number
    reply_users_count: number
    latest_reply: string
    reply_users: string[]
}
client_msg_id: string                         // required (not optional here, unlike GenericMessageEvent)
channel: string
channel_type: ChannelTypes
```

### `File` interface used inside message events (internal to `message.d.ts`, distinct from web-api's `File`)
Source: `message.d.ts:246-304`
```
id: string
created: number
name: string | null
title: string | null
mimetype: string
filetype: string
pretty_type: string
user?: string
editable: boolean
size: number
mode: 'hosted'|'external'|'snippet'|'post'
is_external: boolean
external_type: string | null
is_public: boolean
public_url_shared: boolean
display_as_bot: boolean
username: string | null
url_private?: string
url_private_download?: string
thumb_64?: string ... thumb_1024?: string      // many thumb_* variants, all optional strings
thumb_360_w?: number
thumb_360_h?: number
permalink: string                              // required
permalink_public?: string
edit_link?: string
image_exif_rotation?: number
original_w?: number
original_h?: number
preview?: string
lines?: string
lines_more?: string
shares?: { [key: string]: any }
channels: string[] | null                      // required (nullable)
groups: string[] | null                        // required (nullable)
users?: string[]
pinned_to?: string[]
reactions?: { [key: string]: any }[]
is_starred?: boolean
num_stars?: number
initial_comment?: string
comments_count?: string
```
Practically required: `id`, `name`, `title`, `mimetype`, `filetype`, `size`, `mode`, `permalink`, `url_private`,
`url_private_download`, `user`.

### `app_mention` → `AppMentionEvent`
Source: `@slack/types/dist/events/app.d.ts:102-140`
```
type: 'app_mention'
subtype?: string
bot_id?: string
bot_profile?: BotProfile
username?: string
team?: string
user_team?: string
source_team?: string
user_profile?: {
    name: string; first_name: string; real_name: string; display_name: string; team: string;
    is_restricted?: boolean; is_ultra_restricted?: boolean; avatar_hash?: string; image_72?: string;
}
user?: string
text: string                                   // required
attachments?: MessageAttachment[]
blocks?: (KnownBlock | Block)[]
files?: { id: string }[]
upload?: boolean
display_as_bot?: boolean
edited?: { user: string; ts: string }
ts: string                                     // required
channel: string                                // required
event_ts: string                               // required
thread_ts?: string
client_msg_id?: string
```
Required: `type`, `text`, `ts`, `channel`, `event_ts`. `user` is technically optional in the type, but a real
mention from a human always includes it — the mock should always set it.

### `assistant_thread_started` → `AssistantThreadStartedEvent`
Source: `@slack/types/dist/events/assistant.d.ts:1-14`
```
type: 'assistant_thread_started'
assistant_thread: {
    user_id: string
    context: { channel_id?: string; team_id?: string; enterprise_id?: string | null }
    channel_id: string
    thread_ts: string
}
event_ts: string
```
All of `assistant_thread.{user_id,channel_id,thread_ts}` and `event_ts` are required; `context.*` are all
optional (agent-swarm reads `context.channel_id` when present — see Appendix C).

### `assistant_thread_context_changed` → `AssistantThreadContextChangedEvent`
Source: `assistant.d.ts:15-28` — identical shape to `assistant_thread_started`, only `type` differs.

### `reaction_added` → `ReactionAddedEvent`
Source: `@slack/types/dist/events/reaction.d.ts:1-13`
```
type: 'reaction_added'
user: string                                   // required — the user who reacted
reaction: string                               // required — emoji name, no colons, e.g. "thumbsup"
item_user: string                              // required — author of the reacted-to item
item: { type: 'message'; channel: string; ts: string }   // required
event_ts: string                               // required
```
Note: `item.type` in the installed types is narrowed to only `'message'` (no `'file'`/`'file_comment'` variant
present in this version), so the mock only needs to support message-reactions.

### `member_joined_channel` → `MemberJoinedChannelEvent`
Source: `@slack/types/dist/events/member.d.ts:1-9`
```
type: 'member_joined_channel'
user: string                                   // required
channel: string                                // required
channel_type: string                           // required (plain string here, not the narrowed ChannelTypes union)
team: string                                   // required
inviter?: string
event_ts: string                               // required
```

### `event_callback` envelope (`EnvelopedEvent<Event>`)
Source: `@slack/bolt/dist/types/events/index.d.ts:42-60`
```
token: string
team_id: string
enterprise_id?: string
api_app_id: string
event: Event                                   // one of the event shapes above
type: 'event_callback'                         // literal
event_id: string                               // required — "Ev..." format
event_time: number                             // required — unix seconds (number, NOT the dotted ts string)
is_ext_shared_channel?: boolean
authorizations?: Authorization[]
```
`Authorization` (index.d.ts:54-60):
```
enterprise_id: string | null
team_id: string | null
user_id: string
is_bot: boolean
is_enterprise_install?: boolean
```
Note: `EnvelopedEvent` also `extends StringIndexed` (i.e. it's an open/index-signature object — bolt does not
reject unknown extra top-level fields), so the mock is free to add fields Slack itself sends
(e.g. `context_team_id`, `context_enterprise_id`) without breaking bolt-js.

Over Socket Mode, this `EnvelopedEvent` body is NOT sent bare — it is nested one level deeper as
`socketModeEnvelope.payload`, with `payload.event` = the raw event and type `'events_api'` at the outer socket
envelope level. See "Socket Mode envelope" below.

---

## kind=payload

### `SlashCommand`
Source: `@slack/bolt/dist/types/command/index.d.ts:18-34`

This is the entire **URL-encoded** (not JSON) body of a slash-command POST.
```
token: string
command: string                                // e.g. "/swarm"
text: string                                   // everything after the command
response_url: string                           // required — POST target for delayed responses
trigger_id: string                             // required — needed to open a modal within 3s
user_id: string
user_name: string
team_id: string
team_domain: string
channel_id: string
channel_name: string
api_app_id: string
enterprise_id?: string
enterprise_name?: string
is_enterprise_install?: string                 // NOTE: string ("true"/"false"), not boolean — URL-encoded form
```
All fields except the 3 `enterprise_*`/`is_enterprise_install` are required for a working slash command payload.
`SlackCommandMiddlewareArgs` also extends `StringIndexed`, so unknown extra fields are tolerated by bolt.

### `BlockAction<ElementAction>` (`block_actions` body)
Source: `@slack/bolt/dist/types/actions/block-action.d.ts:206-292`
```
type: 'block_actions'                          // literal
actions: ElementAction[]                       // required, e.g. ButtonAction[]
team: { id: string; domain: string; enterprise_id?: string; enterprise_name?: string } | null
user: { id: string; name?: string; username: string; team_id?: string }   // name only set for Home-tab actions
channel?: { id: string; name: string }
message?: { type: 'message'; user?: string; ts: string; text?: string; [key: string]: any }
view?: ViewOutput
state?: { values: { [blockId: string]: { [actionId: string]: ViewStateValue } } }
token: string
response_url: string                           // required
trigger_id: string                             // required
api_app_id: string
container: StringIndexed                       // required, open shape (e.g. { type: 'message', message_ts, channel_id, is_ephemeral })
app_unfurl?: any
is_enterprise_install?: boolean
enterprise?: { id: string; name: string }
bot_access_token?: string
function_data?: { execution_id: string; function: { callback_id: string }; inputs: FunctionInputs }
```
Practically required for the mock to emit for a button click inside a channel message:
`type`, `actions`, `user.{id,username}`, `channel.{id,name}`, `message.{ts}`, `token`, `response_url`,
`trigger_id`, `api_app_id`, `container`.

`ButtonAction` (block-action.d.ts:17-31, extends `BasicElementAction<'button'>`):
```
type: 'button'
block_id: string                               // required (from BasicElementAction)
action_id: string                               // required
action_ts: string                               // required — dotted-ts-like string, action's own timestamp
value?: string
text: PlainTextElement                          // required
url?: string
confirm?: Confirmation
```

### `ViewSubmitAction` (`view_submission` body)
Source: `@slack/bolt/dist/types/view/index.d.ts:37-60`
```
type: 'view_submission'                        // literal
team: { id: string; domain: string; enterprise_id?: string; enterprise_name?: string } | null
user: { id: string; name: string; team_id?: string }
view: ViewOutput                               // required — see below
api_app_id: string
token: string
trigger_id: string                             // required
is_enterprise_install?: boolean
enterprise?: { id: string; name: string }
response_urls?: ViewResponseUrl[]              // populated only if the view had input blocks with response_url_enabled
```
`ViewResponseUrl` (view/index.d.ts:26-31): `{ block_id: string; action_id: string; channel_id: string; response_url: string }`

`ViewOutput` (`@slack/types/dist/views.d.ts` — actually defined in `@slack/bolt/dist/types/view/index.d.ts:266-301`):
```
id: string
callback_id: string
team_id: string
app_installed_team_id?: string
app_id: string | null
bot_id: string
title: { type: 'plain_text'; text: string; emoji?: boolean }
type: string
blocks: (KnownBlock | Block)[]
close: { type: 'plain_text'; text: string; emoji?: boolean } | null
submit: { type: 'plain_text'; text: string; emoji?: boolean } | null
state: { values: { [blockId: string]: { [actionId: string]: ViewStateValue } } }   // required — the whole point of a submission
hash: string
private_metadata: string                       // required (empty string if unused) — round-tripped by the app
root_view_id: string | null
previous_view_id: string | null
clear_on_close: boolean
notify_on_close: boolean
external_id?: string
entity_url?: string
external_ref?: { id: string; type?: string }
app_unfurl_url?: string
message_ts?: string
thread_ts?: string
channel?: string
```
`view.state.values` is the field agent-swarm actually reads (form input values); `view.private_metadata` and
`view.callback_id` round-trip whatever the app set when opening the view.

`ViewStateValue` (view/index.d.ts:249-265):
```
type: string
value?: string | null
selected_date?: string | null
selected_time?: string | null
selected_date_time?: number | null
selected_conversation?: string | null
selected_channel?: string | null
selected_user?: string | null
selected_option?: { text: PlainTextElement; value: string } | null
selected_conversations?: string[]
selected_channels?: string[]
selected_users?: string[]
selected_options?: { text: PlainTextElement; value: string }[]
rich_text_value?: RichTextBlock
files?: UploadedFile[]
```
For a `plain_text_input` block the mock should populate `{ type: 'plain_text_input', value: '<the text>' }`.

### File object (from `message.d.ts` File — see above — and the near-identical `FilesInfoResponse.File` / `ChatPostMessageResponse` `FileElement`)
Field names the task specifically calls out (all confirmed present, all optional in the API-result variants since
they come back inside `WebAPICallResult`-derived types, but non-optional inside the raw event `File`):
```
id, name, title, mimetype, filetype, size, url_private, url_private_download, permalink, mode, user, created,
channels, thumb_64, thumb_80, thumb_160, thumb_360, thumb_360_w, thumb_360_h, thumb_480, thumb_720, thumb_960,
thumb_1024
```
Source for the API-result shape: `@slack/web-api/dist/types/response/FilesInfoResponse.d.ts:23-100` (File
interface, `id?:string` etc., all optional per `WebAPICallResult &` pattern). Source for the raw-event shape (all
non-optional except thumbs): `message.d.ts:246-304` (above).

---

## kind=envelope — Socket Mode

Source (behavior, not just types — the actual dispatch logic that determines the wire shape):
`@slack/socket-mode/dist/src/SocketModeClient.js:262-332` (`onWebSocketMessage`), types in
`@slack/socket-mode/dist/src/SlackWebSocket.d.ts` and `@slack/web-api/dist/types/response/AppsConnectionsOpenResponse.d.ts`.

### Connection bootstrap: `apps.connections.open`
- Request: `AppsConnectionsOpenArguments = OptionalArgument<object>` (`web-api/dist/types/request/apps.d.ts:4`)
  — i.e. called with `{}` (confirmed at `socket-mode/dist/src/SocketModeClient.js:223`:
  `yield this.webClient.apps.connections.open({})`).
- Response (`AppsConnectionsOpenResponse.d.ts:1-9`):
```
ok?: boolean
error?: string
needed?: string
provided?: string
url?: string                                   // required in practice — wss:// URL bolt connects to; code at
                                                //   SocketModeClient.js:224 throws if resp.url is falsy
```
The mock's HTTP server must serve `POST /apps.connections.open` returning `{ ok: true, url: "ws://<mock-host>:<port>/..." }`.

### Incoming WebSocket message envelope (server → bolt)
The client does `JSON.parse(payload)` on every text frame and branches on `event.type`
(`SocketModeClient.js:273-320`). Three shapes exist:

**1. `hello`** — sent once right after connect to finalize the handshake:
```
{ type: 'hello', ... }        // only `type` is read by the client (SocketModeClient.js:283); extra fields ignored
```
Real Slack also sends `num_connections`, `debug_info: { host, build_number, approximate_connection_time }`,
`connection_info: { app_id }` — none of these are read by this client version, so the mock can omit them, but
including them is harmless and closer to the real contract.

**2. `disconnect`** — server-initiated graceful reconnect signal:
```
{ type: 'disconnect', reason?: string, ... }   // client logs `event.reason` (SocketModeClient.js:289) then
                                                //   disconnects and (if autoReconnectEnabled) reconnects
```
Real Slack reasons include `"warning"` and `"refresh_requested"`.

**3. `events_api`** (or any other `type`) — the actual payload-carrying envelope:
```
{
  type: 'events_api'                           // or 'slash_commands' | 'interactive' — bolt still branches on
                                                //   event.type at SocketModeClient.js:301/314
  envelope_id: string                          // required — client echoes this back verbatim in the ack
  payload: <the shape for that type>            // for events_api: an EnvelopedEvent (event_callback body, see above)
  accepts_response_payload?: boolean            // whether bolt may reply synchronously with response data
  retry_attempt?: number                        // only meaningful for events_api payloads
  retry_reason?: string
}
```
Confirmed by the exact fields the client reads: `event.type`, `event.envelope_id`, `event.payload`,
`event.payload.event.type` (only for `events_api`), `event.accepts_response_payload`, `event.retry_attempt`,
`event.retry_reason` — `SocketModeClient.js:294-331`.

For **slash commands** and **interactive** (block_actions / view_submission) messages sent over Socket Mode, real
Slack sets `type: 'slash_commands'` / `type: 'interactive'` respectively and `payload` is the `SlashCommand` /
`BlockAction` / `ViewSubmitAction` body directly (not further wrapped) — this matches the generic branch at
`SocketModeClient.js:312-320` which just emits `event.type` with `body: event.payload`.

### Outgoing ack (bolt → server)
Source: `SocketModeClient.js:340-354` (`send` method), invoked via the `ack` callback built at
`SocketModeClient.js:294-299`.
```
{
  envelope_id: string                          // required — must match the envelope_id being acknowledged
  payload: object                              // required (defaults to {}); if ack() was called with a string,
                                                //   it's wrapped as { text: <string> }
}
```
The mock's WS server must, for every envelope it sends with a non-empty `envelope_id`, expect exactly one JSON
text frame back matching `{ envelope_id, payload }` before considering the event "acknowledged" (Slack's real
3-second ack timeout is a good default to emulate for retry testing).

---

## kind=response (Web API)

### Generic envelope every response extends
Source: `@slack/web-api/dist/WebClient.d.ts:64-75`
```
ok: boolean                                    // required
error?: string
response_metadata?: {
    warnings?: string[]
    next_cursor?: string
    scopes?: string[]
    acceptedScopes?: string[]
    retryAfter?: number
    messages?: string[]
}
```
Generic **error** shape (`ok: false`) per `WebAPIPlatformError.data` (`@slack/web-api/dist/errors.d.ts:29-34`):
`WebAPICallResult & { error: string }` — i.e. at minimum `{ ok: false, error: "<slack_error_code>" }`, optionally
with `response_metadata.messages` / `.warnings` for extra detail, and (seen on many endpoints, e.g.
`AuthTestResponse`, `ChatPostMessageResponse`) `needed?: string` / `provided?: string` for `missing_scope` errors.
The mock should support at minimum these Slack error strings, since agent-swarm has explicit handling for them:
- `channel_not_found`, `not_in_channel`, `is_archived` (channel-join / lifecycle flows)
- `message_not_found` (chat.update / chat.delete — see `isSlackMessageNotFound` in agent-swarm)
- `missing_scope` (with `needed`/`provided`)
- `ratelimited` (maps to `WebAPIRateLimitedError`, needs a `Retry-After` header, not just a body field —
  `@slack/web-api/dist/errors.d.ts:46-49`)

### `AuthTestResponse`
Source: `response/AuthTestResponse.d.ts:2-18`
```
app_id?: string
app_name?: string
bot_id?: string                                // required in practice — agent-swarm caches this
enterprise_id?: string
error?: string
expires_in?: number
is_enterprise_install?: boolean
needed?: string
ok?: boolean
provided?: string
team?: string
team_id?: string
url?: string
user?: string
user_id?: string                               // required in practice — bot's own U... id, cached by agent-swarm
                                                //   (src/slack/handlers.ts:185-188, src/slack/enrich.ts, etc.)
```

### `ChatPostMessageResponse`
Source: `response/ChatPostMessageResponse.d.ts:2-34`
```
channel?: string
deprecated_argument?: string
error?: string
errors?: string[]
message?: ChatPostMessageResponseMessage       // see below
needed?: string
ok?: boolean
provided?: string
response_metadata?: ResponseMetadata           // { messages?: string[] }
ts?: string                                    // required in practice — agent-swarm reads result.ts to track the message
```
`ChatPostMessageResponseMessage` (same file, lines 14-34):
```
app_id?: string
assistant_app_thread?: { first_user_thread_reply?: string; title?: string; title_blocks?: Block[] }
attachments?: Attachment[]
blocks?: Block[]
bot_id?: string
bot_profile?: BotProfile                       // { app_id?, deleted?, icons?, id?, name?, team_id?, updated? }
icons?: { emoji?: string; image_64?: string }
metadata?: { event_payload?: object; event_type?: string }
parent_user_id?: string
room?: Room                                    // huddle/call metadata, safe to omit in mock
root?: { bot_id?, icons?, latest_reply?, parent_user_id?, reply_count?, reply_users?, reply_users_count?,
          subscribed?, subtype?, text?, thread_ts?, ts?, type?, username? }
subtype?: string
team?: string
text?: string
thread_ts?: string
ts?: string
type?: string
user?: string
username?: string
```
Practically required for the mock's `chat.postMessage` response: top-level `ok`, `channel`, `ts`, and
`message.{ts, text, user or bot_id, type: "message"}`.

### `ChatUpdateResponse`
Source: `response/ChatUpdateResponse.d.ts:2-30`
```
channel?: string
error?: string
message?: Message                              // { app_id?, assistant_app_thread?, blocks?, bot_id?, bot_profile?,
                                                //   display_as_bot?, edited?, files?, metadata?, room?, team?,
                                                //   text?, type?, upload?, user?, x_files? }
needed?: string
ok?: boolean
provided?: string
response_metadata?: ResponseMetadata
text?: string
ts?: string                                    // required in practice — same ts as the message that was updated
```

### `ChatDeleteResponse`
Source: `response/ChatDeleteResponse.d.ts:2-9`
```
channel?: string
error?: string
needed?: string
ok?: boolean
provided?: string
ts?: string                                    // the deleted message's ts, echoed back
```

### `ChatPostEphemeralResponse`
Source: `response/ChatPostEphemeralResponse.d.ts:2-8`
```
error?: string
message_ts?: string                            // NOTE: field name is `message_ts`, not `ts`
needed?: string
ok?: boolean
provided?: string
```

### `ChatGetPermalinkResponse` (used by agent-swarm, not in the original R4 list — see Appendix C)
Source: `response/ChatGetPermalinkResponse.d.ts:2-9`
```
channel?: string
error?: string
needed?: string
ok?: boolean
permalink?: string                             // required in practice — full https://…/archives/C…/p… URL
provided?: string
```

### `ChatStartStreamResponse` / `ChatAppendStreamResponse` / `ChatStopStreamResponse` (used by agent-swarm — Appendix C)
`ChatStartStreamResponse` (`response/ChatStartStreamResponse.d.ts:2-9`) and `ChatAppendStreamResponse`
(`response/ChatAppendStreamResponse.d.ts:2-9`) are identical shapes:
```
channel?: string
error?: string
needed?: string
ok?: boolean
provided?: string
ts?: string                                    // required in practice — the streaming message's ts
```
`ChatStopStreamResponse` (`response/ChatStopStreamResponse.d.ts:3-23`) additionally returns the finalized message:
```
channel?: string
error?: string
needed?: string
ok?: boolean
provided?: string
ts?: string
message?: {
    subtype?: string; text?: string; user?: string; streaming_state?: string; type?: string; ts?: string;
    bot_id?: string; thread_ts?: string; parent_user_id?: string; blocks?: (Block | KnownBlock)[]
}
```
Request shapes worth noting for the mock's request handling (not response, but affects what state to update):
- `ChatStartStreamArguments extends TokenOverridable, Channel, Partial<MarkdownText>, ThreadTS` — requires
  `channel` + `thread_ts`, optional `markdown_text`, plus `recipient_team_id?`/`recipient_user_id?` for
  non-DM contexts (`request/chat.d.ts:173-183`).
- `ChatAppendStreamArguments extends TokenOverridable, ChannelAndTS, MarkdownText` — requires `channel`, `ts`,
  `markdown_text` (`request/chat.d.ts:145-146`).
- `ChatStopStreamArguments = TokenOverridable & ChannelAndTS & Partial<MarkdownText> & Partial<Metadata> & { blocks?: (KnownBlock|Block)[] }`
  (`request/chat.d.ts:185-190`).

### `ConversationsRepliesResponse`
Source: `response/ConversationsRepliesResponse.d.ts:2-37`
```
error?: string
has_more?: boolean
messages?: MessageElement[]                    // required in practice — thread messages, [0] is the root
needed?: string
ok?: boolean
provided?: string
response_metadata?: ResponseMetadata
```
`MessageElement` (same file, lines 11-37): `app_id?, assistant_app_thread?, attachments?, blocks?, bot_id?,
bot_profile?, display_as_bot?, edited?, files?, is_locked?, last_read?, latest_reply?, metadata?, parent_user_id?,
reactions?, reply_count?, reply_users?, reply_users_count?, subscribed?, team?, text?, thread_ts?, ts?, type?,
upload?, user?, x_files?`. Practically required per element: `ts`, `text`, `user` or `bot_id`, `type: "message"`;
the root message additionally needs `thread_ts` (= its own `ts`) + `reply_count` once replies exist.

### `ConversationsHistoryResponse`
Source: `response/ConversationsHistoryResponse.d.ts:2-40`
```
channel_actions_count?: number
channel_actions_ts?: number
error?: string
has_more?: boolean
latest?: string
messages?: MessageElement[]                    // required in practice
needed?: string
ok?: boolean
oldest?: string
pin_count?: number
provided?: string
response_metadata?: ResponseMetadata
```
`MessageElement` is the same shape family as above plus `client_msg_id?, icons?, inviter?, purpose?, root?,
subtype?`. `messages` is returned newest-first (Slack convention) — the mock must sort descending by `ts`.

### `ConversationsListResponse`
Source: `response/ConversationsListResponse.d.ts:2-77`
```
channels?: Channel[]
error?: string
needed?: string
ok?: boolean
provided?: string
response_metadata?: { next_cursor?: string }
```
`Channel` (lines 10-48): `id?, name?, is_channel?, is_group?, is_im?, is_mpim?, is_private?, is_archived?,
is_general?, is_shared?, is_org_shared?, is_member?, is_ext_shared?, is_pending_ext_shared?, is_moved?,
created?, creator?, name_normalized?, num_members?, previous_names?, priority?, properties?, purpose?, topic?,
unlinked?, updated?, user?` + several org/enterprise fields. Practically required per channel: `id`, `name`,
`is_channel`/`is_private`/`is_im`/`is_mpim` (one true), `is_archived`, `is_member`.

### `ConversationsInfoResponse`
Source: `response/ConversationsInfoResponse.d.ts:2-56` — same `Channel` shape as List, plus
`is_read_only?, is_thread_only?, is_non_threadable?, last_read?, locale?`. Top-level: `channel?: Channel`, `ok?`,
`error?`, `needed?`, `provided?`.

### `ConversationsCreateResponse`
Source: `response/ConversationsCreateResponse.d.ts:2-47`. Top-level: `channel?: Channel`, `detail?: string`
(extra error detail), `ok?`, `error?`, `needed?`, `provided?`. `Channel` is a stripped-down version (no
`connected_*`/`internal_team_ids` org fields) plus `is_open?`.

### `ConversationsJoinResponse`
Source: `response/ConversationsJoinResponse.d.ts:2-68`. Top-level adds `warning?: string` and
`response_metadata?: { warnings?: string[] }` alongside `channel?: Channel`, `ok?`, `error?`.

### `ConversationsInviteResponse`
Source: `response/ConversationsInviteResponse.d.ts:2-52`. Top-level: `channel?: Channel`, `errors?: { error?:
string; ok?: boolean; user?: string }[]` (partial-failure per-user invite errors), `ok?`, `error?`, `needed?`,
`provided?`.

### `ConversationsArchiveResponse`
Source: `response/ConversationsArchiveResponse.d.ts:2-7` — trivial: `{ error?, needed?, ok?, provided? }`, no
extra payload fields.

### `ConversationsOpenResponse`
Source: `response/ConversationsOpenResponse.d.ts:2-36`
```
already_open?: boolean
channel?: Channel                              // { context_team_id?, created?, id?, is_archived?, is_im?,
                                                //   is_open?, is_org_shared?, last_read?, latest?: Latest,
                                                //   priority?, unread_count?, unread_count_display?, updated?, user? }
error?: string
needed?: string
no_op?: boolean
ok?: boolean
provided?: string
```

### `UsersInfoResponse`
Source: `response/UsersInfoResponse.d.ts:2-88`
```
error?: string
needed?: string
ok?: boolean
provided?: string
user?: User
```
`User` (lines 9-37): `color?, deleted?, enterprise_user?, has_2fa?, id?, is_admin?, is_app_user?, is_bot?,
is_connector_bot?, is_email_confirmed?, is_invited_user?, is_owner?, is_primary_owner?, is_restricted?,
is_stranger?, is_ultra_restricted?, is_workflow_bot?, locale?, name?, profile?: Profile, real_name?, team_id?,
tz?, tz_label?, tz_offset?, updated?, who_can_share_contact_card?`.
`Profile` (lines 47-82) — the block agent-swarm actually reads (`src/slack/enrich.ts`):
```
always_active?: boolean
api_app_id?: string
avatar_hash?: string
bot_id?: string
display_name?: string
display_name_normalized?: string
email?: string                                 // required in practice — agent-swarm's identity-enrichment keys on this
first_name?: string
image_24?/32?/48?/72?/192?/512?/1024?/original?: string
is_custom_image?: boolean
last_name?: string
phone?: string
pronouns?: string
real_name?: string
real_name_normalized?: string
status_emoji?: string
status_text?: string
team?: string
title?: string
```

### `UsersLookupByEmailResponse`
Source: `response/UsersLookupByEmailResponse.d.ts:2-76` — same top-level shape (`error?, needed?, ok?, provided?,
response_metadata?: { messages?: string[] }, user?: User`) with a near-identical but slightly smaller `User`/
`Profile` (no `enterprise_user`, no `is_connector_bot`/`is_stranger`/`is_workflow_bot`/`bot_id` on Profile).

### `ReactionsAddResponse` / `ReactionsRemoveResponse`
Source: `response/ReactionsAddResponse.d.ts:2-7`, `response/ReactionsRemoveResponse.d.ts:2-7` — both trivial:
`{ error?: string; needed?: string; ok?: boolean; provided?: string }`. No echo of the reaction/channel/ts.

### `FilesInfoResponse`
Source: `response/FilesInfoResponse.d.ts:2-14` (top) + `File` interface (lines 23-165, huge — legacy Slack Lists
fields included). Top-level:
```
comments?: Comment[]                           // legacy file-comments feature; empty array is fine
content?: string
content_highlight_css?: string
content_highlight_html?: string
content_highlight_html_truncated?: boolean
error?: string
file?: File
is_truncated?: boolean
needed?: string
ok?: boolean
paging?: Paging
provided?: string
```
`File` — practically required subset (full list is the ~140-field superset already documented under "File object"
above): `id, name, title, mimetype, filetype, pretty_type, user, size, mode, is_external, is_public, url_private,
url_private_download, permalink, timestamp, created, channels, thumb_64...thumb_1024`.

### `FilesGetUploadURLExternalResponse`
Source: `response/FilesGetUploadURLExternalResponse.d.ts:2-10`
```
error?: string
file_id?: string                               // required in practice — the F... id to reference in the complete call
needed?: string
ok?: boolean
provided?: string
response_metadata?: { messages?: string[] }
upload_url?: string                            // required in practice — where the client PUTs/POSTs the raw file bytes
```
This is the modern (`files.getUploadURLExternal` + raw upload + `files.completeUploadExternal`) 3-step upload flow
that superseded `files.upload`.

### `FilesCompleteUploadExternalResponse`
Source: `response/FilesCompleteUploadExternalResponse.d.ts:2-9` (top) + `File` (lines 10-67, smaller subset than
`FilesInfoResponse.File`):
```
files?: File[]                                 // required in practice
error?: string; needed?: string; ok?: boolean; provided?: string
response_metadata?: { messages?: string[] }
```
`File` here: `id?, name?, title?, mimetype?, filetype?, pretty_type?, user?, size?, mode?, is_external?,
is_public?, url_private?, url_private_download?, permalink?, permalink_public?, timestamp?, created?, channels?,
groups?, ims?, shares?, thumb_64...thumb_tiny`.

### `ViewsOpenResponse`
Source: `response/ViewsOpenResponse.d.ts:2-90+`
```
error?: string
needed?: string
ok?: boolean
provided?: string
response_metadata?: { messages?: string[] }
view?: View                                    // required in practice
warning?: string
```
`View` (response variant — note the field NAMES differ slightly from bolt's `ViewOutput`, e.g. `submit_disabled`
is present here but not on `ViewOutput`): `app_id?, app_installed_team_id?, blocks?, bot_id?, callback_id?,
clear_on_close?, close?, external_id?, hash?, id?, notify_on_close?, previous_view_id?, private_metadata?,
root_view_id?, state?, submit?, submit_disabled?, team_id?, title?, type?`. The mock should echo back the `view`
the caller passed to `views.open`, plus generate `id` (format `V...`), `hash`, `team_id`.

### `AssistantThreadsSetStatusResponse` / `SetTitleResponse` / `SetSuggestedPromptsResponse`
Source: `response/AssistantThreadsSetStatusResponse.d.ts:2-8`,
`AssistantThreadsSetTitleResponse.d.ts:2-8`, `AssistantThreadsSetSuggestedPromptsResponse.d.ts:2-8` — all three
identical trivial shape: `{ error?: string; needed?: string; ok?: boolean; provided?: string; warning?: string }`.
No echo of the status/title/prompts that were set.

### `AppsConnectionsOpenResponse`
Source: `response/AppsConnectionsOpenResponse.d.ts:2-8` — see "Socket Mode" section above.
```
error?: string
needed?: string
ok?: boolean
provided?: string
url?: string
```

### Generic error shape (recap)
```
{ ok: false, error: string, needed?: string, provided?: string,
  response_metadata?: { messages?: string[]; warnings?: string[] } }
```

---

## Appendix A — `BotProfile` (shared common type, referenced by many event/response shapes)
Source (raw-event variant): `@slack/types/dist/common/bot-profile.d.ts:1-11`
```
id: string
name: string
app_id: string
team_id: string
icons: { [size: string]: string }
updated: number
deleted: boolean
```
(All required — this is the raw-event variant, unlike the `BotProfile` embedded in Web API responses where every
field is optional, e.g. `response/ChatPostMessageResponse.d.ts:918-925`.)

## Appendix B — `Edited` sub-object (message-changed / update responses)
```
ts?: string
user?: string
```
(`response/ChatPostMessageResponse.d.ts:967-969`, mirrored in the raw-event `edited?: { user: string; ts: string
}` on `GenericMessageEvent`/`BotMessageEvent`/`AppMentionEvent` — note the response variant has both fields
optional while the event variant has both required.)

## Appendix C — confirmed real call-sites in agent-swarm (evidence that the above shapes are load-bearing)
All paths relative to `/Users/taras/Documents/code/agent-swarm`:
- `src/slack/app.ts:44-47` — `new App({ token: botToken, appToken, socketMode: true, ... })` — confirms Socket
  Mode is actually used (not HTTP Events API), so the Socket Mode envelope section above is the primary contract.
- `src/slack/thread-buffer.ts:96` — `app.client.conversations.replies(...)`
- `src/slack/thread-buffer.ts:179,245` and `src/slack/responses.ts:402` — `client.chat.postMessage(...)`
- `src/slack/actions.ts:34` — `client.views.open(...)`
- `src/slack/actions.ts:109` — `client.chat.postMessage(...)`
- `src/slack/actions.ts:159`, `src/slack/responses.ts:255,328,372`, `src/slack/render-v2.ts:421,552,806` —
  `client.chat.update(...)`
- `src/slack/channel-lifecycle.ts:40,68,81,99` — `conversations.create` / `conversations.invite` /
  `conversations.archive`
- `src/slack/channel-join.ts:40,83` — `conversations.info` / `conversations.join` (fallback on `not_in_channel`)
- `src/slack/ack.ts:29,47` — `reactions.add` / `reactions.remove`
- `src/slack/channel-activity.ts:63,75,86,160` — `auth.test`, `conversations.history`, `conversations.list`
- `src/slack/handlers.ts:243,296` — `conversations.replies` (thread-root author resolution)
- `src/slack/handlers.ts:437` — `auth.test` (cached bot user id)
- `src/slack/handlers.ts:540` — `reactions.add` (ack emoji on incoming message)
- `src/slack/enrich.ts:78` — `users.info` (email/display-name enrichment, reads `user.profile.email`)
- `src/slack/files.ts:274` — `files.info`
- `src/slack/watcher.ts:437` — `assistant.threads.setStatus`
- `src/slack/render-v2.ts:289` — `chat.getPermalink` (not in the original R4 list, added above)
- `src/slack/render-v2.ts:403,421,552,678,791,806,813` — `chat.postMessage`, `chat.update`, `auth.test`,
  `chat.startStream`, `chat.stopStream` (streaming reply flow — not in the original R4 list, added above)
- `src/slack/message-text.ts:184,195-202` — dotted `ts` format parser/normalizer (confirms the `"<sec>.<usec>"`
  format documented at the top of this doc)
