# slack-mock design

A mock Slack server for end-to-end testing Slack bots, built for the agent-swarm
Slack integration (Bolt 4, Socket Mode). Bun + TypeScript, zero runtime
dependencies.

Research that drove the design lives in `docs/research/` (one file per topic,
written by parallel research agents and verified against the installed
`@slack/*` sources and live probes).

## What it does

- Serves the Slack Web API at `POST /api/<method>` and a Socket Mode endpoint
  (`apps.connections.open` hands out a `ws://.../link/?ticket=...` URL). Bolt
  connects with `clientOptions: { slackApiUrl }`; nothing else in the bot changes.
- Keeps a Slack-shaped workspace in memory (team, users, channels, DMs,
  messages, threads, reactions, files, views, assistant thread state) and
  optionally journals every change as JSON lines (`dataFile`), replaying the
  file on start.
- Is bidirectional. Tests inject what humans do (messages, mentions, file
  uploads, slash commands, button clicks, modal submissions, assistant threads)
  and the bot's Web API calls (post, update, delete, react, upload, stream,
  views.open, assistant.threads.*) land in the same store. Slack semantics are
  kept: the bot's own messages are echoed back as events (Bolt's `ignoreSelf`
  drops them), edits become `message_changed`, deletes `message_deleted`,
  membership gates events and `not_in_channel`.
- Renders HTML (`/`, `/c/:channel`, `/c/:channel/t/:ts`) that looks like
  Slack, with Block Kit and mrkdwn support, plus `?screenshot` mode and a
  headless-Chrome screenshot helper.

## Layout

| file | role |
|---|---|
| `src/server.ts` | `SlackMock`: Bun.serve wiring (HTTP + WS), auth, fault injection, event dispatch, the test-facing API and the `/mock/*` admin JSON API |
| `src/web-api.ts` | one handler per Web API method; throws `SlackApiError(code)` for `ok:false` |
| `src/socket-mode.ts` | `SocketModeHub`: connections, hello, envelope delivery, ack tracking, redelivery with `retry_attempt`, server pings, disconnect |
| `src/events.ts` | payload builders: `event_callback` wrapper, message/app_mention/message_changed/message_deleted/reaction/member/assistant events, slash command, `block_actions`, `view_submission` |
| `src/store.ts` | in-memory workspace + JSONL journal, thread bookkeeping, pagination |
| `src/body.ts` | request parsing: form-urlencoded (with JSON-stringified `blocks`/`metadata`/...), JSON, multipart |
| `src/render/` | HTML pages, mrkdwn to HTML, Block Kit to HTML |
| `src/screenshot.ts` | headless Chrome PNG capture |
| `src/cli.ts` | `slack-mock serve` and `slack-mock screenshot` |

## Decisions

- **Bun + TypeScript.** agent-swarm is Bun; `Bun.serve` gives HTTP and
  WebSocket in one process and auto-answers ping frames. No framework.
- **Pluggability by base URL, not by network tricks.** `@slack/web-api` has
  no env override and disables proxies. The bot passes
  `clientOptions.slackApiUrl`; agent-swarm reads it from `SLACK_API_URL`
  (three-line patch in `src/slack/app.ts`).
- **HTTP 200 with `ok:false` for business errors.** Bolt's per-listener
  clients retry non-200 up to 100 times. Real 429/5xx only via `injectFault`.
- **Echo bot messages.** Slack delivers the bot's own messages as events;
  Bolt drops them. Off with `echoBotMessages: false`.
- **Manifest-driven subscriptions.** `manifest: "slack-manifest.json"` sets the
  app name, declared slash commands and `bot_events`. Without a manifest every
  message/mention/reaction/assistant event is delivered.
- **Ack policy lives in the mock.** Bolt acks Events API envelopes before
  listeners run and has no ack timeout for commands/actions. The hub
  redelivers after `ackTimeoutMs` (3s) with `retry_attempt` and gives up after
  `maxRetries`.
- **Pings.** The client pings every 1.7s and needs pongs (Bun does that). The
  server-ping watchdog only arms after the first server ping, so the hub pings
  every 10s, never "once".
- **Events are dropped, not queued, when no app is connected.** Same as Slack.
  Tests call `waitForConnection()` first.
- **Streaming.** `chat.startStream` / `appendStream` / `stopStream` keep
  `markdown_text` as the message text with `streaming_state`; a second stop
  fails with `message_not_in_streaming_state`.
- **Metadata gating.** `conversations.history/replies` only return
  `metadata` with `include_all_metadata=true`, which Bolt's assistant thread
  context store relies on.

## Test-facing API (in-process)

```ts
const slack = await SlackMock.start({ port: 0, manifest: "slack-manifest.json" });
new App({ token: slack.env.SLACK_BOT_TOKEN, appToken: slack.env.SLACK_APP_TOKEN,
          socketMode: true, clientOptions: { slackApiUrl: slack.env.SLACK_API_URL } });
await slack.waitForConnection();
const ask = await slack.postMessage({ channel: "general", user: "alice", text: `<@${slack.bot.userId}> hi` });
const reply = await slack.waitForMessage({ channel: "general", thread_ts: ask.ts, from: "bot" });
await slack.slashCommand({ command: "/agent-swarm-status" });
await slack.clickButton({ channel: "general", ts: reply.ts, action_id: "cancel_task" });
slack.injectFault({ method: "chat.postMessage", error: "ratelimited", httpStatus: 429, retryAfterSec: 1 });
slack.apiCalls("chat.update"); slack.deliveries(); slack.thread("general", ask.ts);
```

The same operations exist over HTTP under `/mock/*` for the CLI / out-of-process
use (`/mock/messages`, `/mock/commands`, `/mock/actions`, `/mock/views/submit`,
`/mock/assistant/start`, `/mock/reactions`, `/mock/channels`, `/mock/users`,
`/mock/channels/:id`, `/mock/channels/:id/threads/:ts`, `/mock/api-calls`,
`/mock/state`, `/mock/disconnect`).

## Status (2026-09-03)

- Core (store, Web API, Socket Mode, events, admin API, CLI, screenshot): done.
- HTML renderer (`src/render`): done. Image and file links carry `?t=<bot token>`
  so a browser can load `/files-pri/...`, which otherwise needs a bearer token.
- Integration tests with the real Bolt client: `bun test`, 50 tests green
  (web API, files, interactivity, assistant, streaming, socket mode
  redelivery and reconnect, faults, JSONL persistence, renderer).
- agent-swarm e2e (`bun run test:e2e`): green. Boots the real API server,
  a channel mention creates a task, a fake lead claims and finishes it over
  HTTP, the watcher posts the outcome, reactions flip to white_check_mark,
  `/agent-swarm-status` answers ephemerally, and the thread is screenshotted
  to `test/artifacts/agent-swarm-thread.png`.

## Not in the MVP

- HTTP mode (Events API over HTTP with signed requests) instead of Socket Mode.
- Rate limiting by default, user tokens, search.*, pins, bookmarks, Canvas,
  huddles, user groups, workflows, app_home.
- The seed script `slack-thread-flatten` in agent-swarm hardcodes
  `https://slack.com` and cannot be redirected.
