# Research assessment: what a Slack mock needs to e2e test agent-swarm

Date: 2026-09-03. Sources: seven parallel research agents reading agent-swarm
(`/Users/taras/Documents/code/agent-swarm`), the installed `@slack/bolt 4.6.0`,
`@slack/socket-mode 2.0.5` and `@slack/web-api 7.13.0`, live probes against
throwaway servers, and Slack's documentation. Detail per topic:

| doc | topic |
|---|---|
| `research/01-outbound-web-api.md` | every Web API call agent-swarm makes, args, response fields read, error codes handled |
| `research/02-inbound-events.md` | every Bolt listener, payload fields read, filters, the eight end-to-end flows, dedup |
| `research/03-library-internals.md` | how Bolt / socket-mode / web-api behave on the wire (45 claims with file:line evidence, adversarially verified) |
| `research/04-payload-shapes.md` | exact event, command, interactive and response shapes from `@slack/types` |
| `research/05-protocol-and-prior-art.md` | official Socket Mode / Events API contract and existing mock servers |
| `research/06-agent-swarm-e2e.md` | how to boot agent-swarm against a mock, env, test conventions, prior test doubles |
| `research/07-block-kit-surface.md` | the blocks, elements, mrkdwn and modals agent-swarm renders |

## 1. The one blocker: pluggability

agent-swarm builds `new App({ token, appToken, socketMode: true })` with no
`clientOptions`. `@slack/web-api` pins `https://slack.com/api/`, reads no
environment variable and disables proxies (`proxy: false`). The only lever is
`clientOptions.slackApiUrl`, which Bolt forwards to both its Web API client and
the socket-mode client's internal client that calls `apps.connections.open`
(verified in source and by a live probe). Network interception (hosts file plus
TLS cert) is the only zero-code route and is not worth it.

Decision: agent-swarm reads `SLACK_API_URL` into `clientOptions.slackApiUrl`
(three lines in `src/slack/app.ts`, applied locally). One thing stays
unreachable: the seed script `slack-thread-flatten` hardcodes `https://slack.com`.

## 2. Wire contract the mock must honour

Socket Mode (all verified against socket-mode 2.0.5 source and probes):

- `POST /api/apps.connections.open` with `Authorization: Bearer xapp-...`, form
  body, must return `{ ok, url }`. The client reads only `url`.
- Plain RFC 6455 upgrade, no subprotocol, no auth header. First text frame must
  be `{"type":"hello"}`; only `type` is read. `app.start()` resolves on it.
- Envelopes: `{ envelope_id, type: events_api|slash_commands|interactive,
  accepts_response_payload, retry_attempt, retry_reason, payload }`. Bolt
  classifies by the payload's keys (`event`, `command`, `actions`,
  `type: view_submission`), not by the envelope type.
- Acks are `{ envelope_id, payload }`. Bolt acks Events API envelopes before any
  listener runs; commands, actions and views are acked when the listener calls
  `ack(...)`, and the argument becomes `payload` (that is how slash commands
  return a body). There is no Bolt-side ack timeout in Socket Mode, so the mock
  owns redelivery (Slack retries with `retry_attempt` and `retry_reason`).
- Client pings every 1.7s (`clientPingTimeout / 3`) with a text payload and
  needs pong frames; four missed pongs tear the link down. The server-ping
  watchdog (30s) arms only after the first server ping, so ping regularly or not
  at all. `Bun.serve` auto-pongs.
- `{"type":"disconnect","reason":...}` closes the socket; every reason
  reconnects after a linear `5s * failures` backoff with a fresh
  `apps.connections.open`. The server must echo close frames.
- Fatal `apps.connections.open` errors: `not_authed`, `invalid_auth`,
  `account_inactive`, `user_removed_from_team`, `team_disabled`.

Web API:

- Always `POST`, `application/x-www-form-urlencoded`; nested values
  (`blocks`, `attachments`, `metadata`, `files`, `view`, `prompts`) travel as
  JSON strings. Multipart only for binary uploads. `Authorization: Bearer`.
- Respond HTTP 200 with `{ ok: false, error }` for business failures.
  Non-200 is retried: Bolt's per-listener clients inherit
  `retryConfig { retries: 100 }` from a socket-mode side effect. 429 needs an
  integer `Retry-After` and pauses the whole client queue.
- `auth.test` runs once at `new App()` and must return `user_id` and `bot_id`;
  they feed `ignoreSelf`, which drops any event whose `user` is the bot user.
- `files.uploadV2` is `files.getUploadURLExternal` (`filename`, `length`) then a
  multipart POST to the returned URL (one part named `body`) then
  `files.completeUploadExternal` (`files: [{id,title}]`, `channel_id`,
  `thread_ts`, `initial_comment`). No `files.info` polling. The app reads
  `result.files[0].files[0].id`.
- Bolt's Assistant middleware swallows DM messages that have `thread_ts`,
  `channel_type: "im"` and no subtype (or `file_share`); `app.event("message")`
  never sees them. Its thread context store needs `conversations.replies` with
  `include_all_metadata` to return the bot's first message with its `metadata`.

## 3. What agent-swarm sends and consumes

Outbound (21 methods): `chat.postMessage` (14 sites, persona `username` and
`icon_emoji`, `metadata.event_type "agent_swarm_render_v2"`), `chat.update`,
`chat.delete`, `chat.getPermalink` (used as a liveness probe), `chat.startStream`
and `chat.stopStream` (`markdown_text`, render-v2 outcome cards),
`conversations.replies|history|list|info|join|create|invite|archive`, `auth.test`,
`users.info` (`profile.email` for domain allow-lists), `reactions.add|remove`
(`eyes`, `heavy_plus_sign`, `zap`, `speech_balloon`, `white_check_mark`, `x`),
`files.info`, `filesUploadV2`, `views.open`, `assistant.threads.setStatus`, plus
Bolt's `setTitle`, `setSuggestedPrompts`, `respond()` to `response_url`, and a
raw `fetch(url_private_download)` with a bearer token. Error codes it branches
on: `not_in_channel` (auto-join), `already_reacted`, `no_reaction`,
`message_not_found`, `channel_not_found`, `thread_not_found`,
`cant_update_message`, `name_taken`, `already_in_channel`, `already_archived`,
`method_not_supported_for_channel_type`, `missing_scope` (`needed`),
`message_not_in_streaming_state`, `ratelimited`.

Inbound: `message` (the only real handler, 460 lines of filters), `app_mention`
(log only), `/agent-swarm-status`, `/agent-swarm-help`, actions
`view_task_logs`, `follow_up_task` (opens a modal), `cancel_task`
(`chat.update` on `body.message.ts`), view `follow_up_submit`, and the Assistant
callbacks. It reads `body.event_id` for dedup, `event.text|user|channel|ts|
thread_ts|subtype|bot_id|files`, mention as the literal `<@BOTID>`,
`command.response_url`, `action.value`, `body.trigger_id`,
`view.private_metadata`, `view.state.values.follow_up_input.follow_up_text.value`.
Its watcher polls the DB every 3s and posts outcomes; no LLM is involved in
that loop.

## 4. Requirements, and what the MVP does with them

| need | MVP |
|---|---|
| Bolt connects unchanged | `SlackMock.env` gives the three variables; `apps.connections.open`, hello, envelopes, acks, pings, disconnect, reconnect all implemented and tested with the real client |
| every method above with the exact response fields and error codes | `src/web-api.ts`, 40 methods; errors as HTTP 200 `ok:false`; `injectFault` for 429 / `missing_scope` / anything else |
| faithful events | `message` (all channel types, `file_share`, `message_changed`, `message_deleted`, `thread_broadcast`), `app_mention` plus `message` for a mention (separate `event_id`s), bot echoes, `reaction_added`, `member_joined_channel`, assistant events; manifest-driven subscriptions |
| commands and interactivity | `slash_commands` and `interactive` envelopes with `response_url` and `trigger_id` served by the mock; ack payloads become ephemeral or in-channel messages; `views.open` validates and expires trigger ids |
| files both ways | upload v2 flow, human uploads, download URLs gated by bearer token, `thumb_*` for images |
| storage | in-memory workspace plus JSONL journal with replay |
| visualization | HTML channel and thread pages with Block Kit and mrkdwn, `?screenshot`, headless Chrome capture |
| test ergonomics | `postMessage`, `waitForMessage`, `waitForApiCall`, `apiCalls`, `deliveries`, `flush`, `thread` |
| agent-swarm e2e without LLM or Docker | `bun run test:e2e`: boots the real API server, mention creates a task, fake lead claims it over `/api/poll`, finishes it, watcher posts the outcome, reactions flip to `white_check_mark`, slash command answers ephemerally |

## 5. Gaps and risks

- HTTP mode (Events API over HTTPS with request signing) is not implemented;
  the transport layer is isolated in `src/server.ts`, so it is an additive
  receiver later.
- Rate limiting is opt-in fault injection, not the tiered limits Slack applies.
- The manifest lacks `assistant_thread_context_changed` although agent-swarm
  registers a handler; the mock can send it when asked.
- `assistant_app_thread` root messages and streaming message rendering follow
  observed behaviour, not published types.
- Persona messages posted with `username` sometimes lack `bot_id` on real
  Slack (agent-swarm has a comment about duplicate tasks); the mock always sets
  `bot_id`. Add a knob if that path needs testing.
- Only one Slack team, one app and one bot user are modelled.

## 6. Prior art

Existing mocks are HTTP-only, unmaintained, or Python-side test fixtures
(`python-slack-sdk`'s `mock_socket_mode_server.py` covers the envelope shapes
but no state). None store messages or render them. See `research/05`.
