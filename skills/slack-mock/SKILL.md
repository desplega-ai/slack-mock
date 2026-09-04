---
name: slack-mock
description: Test a Slack bot end to end without a Slack workspace using @desplega.ai/slack-mock, a mock Slack server (Web API + Socket Mode) with message storage, an HTML viewer and screenshots. Use when writing or running e2e tests for a Bolt app (agent-swarm included), when you need to inject Slack messages, slash commands, button clicks or modal submissions toward a bot and assert its replies, reactions, edits or uploads, or when you want a screenshot of a Slack thread produced by a bot.
---

# slack-mock

`@desplega.ai/slack-mock` is a Slack server that lies convincingly. A real
`@slack/bolt` app connects to it over Socket Mode with only one change:
`clientOptions.slackApiUrl`. Everything the bot posts lands in an in-memory
workspace you can query, journal to JSONL, view in a browser, or screenshot.

## Install

```bash
bun add -d @desplega.ai/slack-mock
# before it is on npm: bun add -d github:desplega-ai/slack-mock
```

Bun is the runtime (the package ships Bun-targeted JS plus TypeScript sources).

## Point the bot at the mock

```ts
import { SlackMock } from "@desplega.ai/slack-mock";

const slack = await SlackMock.start({ port: 0, manifest: "slack-manifest.json" });
slack.env; // { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_API_URL, SLACK_SIGNING_SECRET }
```

- In-process Bolt app: `new App({ token, appToken, socketMode: true, clientOptions: { slackApiUrl: slack.env.SLACK_API_URL } })`.
- Separate process (agent-swarm): spawn it with `...slack.env`. agent-swarm reads `SLACK_API_URL` (PR #1310). Set `NODE_ENV=test`, not `development`, or its socket-mode guard refuses to connect.
- Always `await slack.waitForConnection()` before injecting anything. Events sent while no app is connected are dropped, like Slack does.
- Pass the app's `slack-manifest.json` so the mock only delivers the subscribed `bot_events`, knows the declared slash commands and names the bot correctly.

## Drive the bot (what humans do)

```ts
const ask = await slack.postMessage({ channel: "general", user: "alice", text: `<@${slack.bot.userId}> review PR 42` });
await slack.postMessage({ channel: "general", user: "bob", thread_ts: ask.ts, text: "me too", files: [{ name: "log.txt", content: "..." }] });
await slack.editMessage("general", ask.ts, "edited text");         // message_changed
await slack.deleteMessage("general", ask.ts);                      // message_deleted
await slack.addReaction({ channel: "general", ts: ask.ts, name: "eyes", user: "bob" });
const cmd = await slack.slashCommand({ command: "/agent-swarm-status", user: "alice", channel: "general" });
const ack = await slack.clickButton({ channel: "general", ts: reply.ts, action_id: "cancel_task", user: "alice" });
await slack.submitView({ callback_id: "follow_up_submit", values: { follow_up_input: { follow_up_text: { type: "plain_text_input", value: "more" } } } });
const dm = await slack.startAssistantThread({ user: "alice", context: { channel_id: "C0GENERAL0" } });
await slack.postMessage({ channel: dm.channel, thread_ts: dm.thread_ts, user: "alice", text: "status?" });
```

Seeded workspace: users `alice` (`U0ALICE000`, admin) and `bob` (`U0BOB00000`),
channel `#general` (`C0GENERAL0`) with the bot as a member. `addUser`,
`addChannel({ name, members, withBot })`, `openDm(user)` and `invite` extend it.
Mentions must be the literal `<@BOTUSERID>`; the `/mock/messages` HTTP route
also accepts `@name`.

## Assert (what the bot did)

```ts
const reply = await slack.waitForMessage({ channel: "general", thread_ts: ask.ts, from: "bot" }, { timeoutMs: 30_000 });
await slack.waitForApiCall("reactions.add", { where: (c) => c.args.name === "eyes" });
slack.thread("general", ask.ts);            // parent + replies, Slack shapes (blocks, reactions, files, metadata)
slack.messages("general");                  // top-level messages
slack.ephemeralMessages("general");         // chat.postEphemeral and ephemeral command responses
slack.apiCalls("chat.update");              // every Web API call with its args and ok/error
slack.deliveries();                         // every Socket Mode envelope with ack status and attempts
slack.assistantThread(dm.channel, dm.thread_ts); // status, title, prompts set via assistant.threads.*
await slack.flush();                        // wait for acks and response_url follow-ups
```

`waitForMessage` accepts a query (`channel`, `thread_ts`, `from: "bot" | "human" | userId`,
`text` string or RegExp, `event_type` for metadata) or a predicate.

## Break things

```ts
slack.injectFault({ method: "chat.postMessage", error: "ratelimited", httpStatus: 429, retryAfterSec: 1 });
slack.injectFault({ method: "conversations.join", error: "missing_scope", extra: { needed: "channels:join" } });
slack.disconnectSockets("refresh_requested");   // Bolt reconnects after ~5s
SlackMock.start({ ackTimeoutMs: 200, maxRetries: 1, triggerIdTtlMs: 3000, echoBotMessages: false, eventDelayMs: 50 });
```

Slack semantics kept on purpose: business errors are HTTP 200 `{ ok: false, error }`
(Bolt retries real 5xx up to 100 times); the bot's own messages are echoed back as
events and Bolt's `ignoreSelf` drops them; `not_in_channel` until the bot joins;
Events API envelopes are acked by Bolt before listeners run, so redelivery only
hits slow command, action and view handlers.

## Look at it

- `slack.baseUrl` serves `/` (workspace), `/c/<channel>` and `/c/<channel>/t/<ts>`
  (thread side panel). Add `?refresh=2` for a live view, `?screenshot` for a
  chrome-free capture, `?panel=60` or `?full` for the thread layout.
- `await screenshot(`${slack.baseUrl}/c/C0GENERAL0/t/${ask.ts}`, { out: "thread.png" })`
  uses headless Chrome (set `SLACK_MOCK_CHROME` if it is not in a default location).
- CLI: `slack-mock serve --port 4040 --manifest app.json [--data run.jsonl]`, then
  `curl -X POST :4040/mock/messages -d '{"channel":"general","user":"alice","text":"@agent-swarm hi"}'`,
  and `slack-mock screenshot <url> --out shot.png`. The UI has a composer with
  `@` autocomplete for manual poking.
- `dataFile` / `--data` appends every change as JSONL and replays it on start.
- `await frames({ journal: "run.jsonl", channel: "general", thread: ask.ts, out: "./frames" })`
  (or `slack-mock frames --journal run.jsonl --channel C0GENERAL0 --thread <ts> --out ./frames`)
  renders one PNG per journal line that touched the thread (`01-message.add.png`, ...), plus
  `final-thread.png` and `final-desktop.png`. Leave out `thread` for the channel view. No server
  is started; stitch the PNGs into a GIF with ffmpeg if you want motion.

## Recipe: agent-swarm end to end, no LLM, no Docker

1. `SlackMock.start({ port: 0, manifest: "<agent-swarm>/slack-manifest.json" })`.
2. Spawn `bun src/http.ts` in the agent-swarm checkout with `PORT`, a scratch
   `DATABASE_PATH`, `API_KEY` + `AGENT_SWARM_API_KEY`, `NODE_ENV=test`,
   `...slack.env`, and `GITHUB_DISABLE=JIRA_DISABLE=LINEAR_DISABLE=OAUTH_KEEPALIVE_DISABLE=true`.
   Poll `/health`, then `slack.waitForConnection()`.
3. Register a lead: `POST /api/agents { name, isLead: true }` with
   `Authorization: Bearer <key>` and a UUID `X-Agent-ID`.
4. Mention the bot; wait for `reactions.add` (`eyes`) and the threaded reply.
5. Find the task (`GET /api/tasks?source=slack&fields=full`), claim it with one
   `GET /api/poll` as the lead (polling again mid-task looks like a crash), finish
   it with `POST /api/tasks/<id>/finish { status: "completed", output }`.
6. Wait for the outcome message in the thread and the `white_check_mark`
   reaction (the watcher ticks every 3s). Screenshot the thread, or record with
   `dataFile` and run `frames()` on the journal for one PNG per step.

The full version is `test/agent-swarm.e2e.test.ts` in the slack-mock repo.

## Not covered

HTTP (non Socket Mode) receivers, request signing, real rate-limit tiers, user
tokens and `search.*`, multiple teams.
