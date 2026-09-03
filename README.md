# slack-mock

A mock Slack server for end-to-end testing Slack bots. It speaks the Slack Web
API and Socket Mode, so a real `@slack/bolt` app connects to it unchanged
(only `clientOptions.slackApiUrl` differs). Messages, threads, reactions,
files, modals and assistant threads are stored, journaled as JSONL, and
rendered as Slack-looking HTML for screenshots.

Built for the [agent-swarm](../agent-swarm) Slack integration. Bun + TypeScript,
no runtime dependencies.

## Install

```bash
bun add -d @desplega.ai/slack-mock          # from npm (once published)
bun add -d github:desplega-ai/slack-mock    # or straight from the repo (Bun runs the TypeScript sources)
```

## Quick start (from a checkout)

```bash
bun install
bun run start                 # slack-mock serve --port 4040
bun run demo                  # same, seeded with threads, blocks, files, an ephemeral and a DM
```

Point your bot at it:

```bash
SLACK_BOT_TOKEN=xoxb-mock-bot-token \
SLACK_APP_TOKEN=xapp-mock-app-token \
SLACK_API_URL=http://127.0.0.1:4040/api/ \
bun src/http.ts               # agent-swarm reads SLACK_API_URL into clientOptions.slackApiUrl
```

Talk to the bot as a human and watch the thread:

```bash
curl -X POST http://127.0.0.1:4040/mock/messages -H 'content-type: application/json' \
  -d '{"channel":"general","user":"alice","text":"<@U0BOT00000> hello"}'
open http://127.0.0.1:4040/c/general            # live view (add ?refresh=2)
bun src/cli.ts screenshot http://127.0.0.1:4040/c/general --out general.png
```

## In tests

```ts
import { App } from "@slack/bolt";
import { SlackMock } from "@desplega.ai/slack-mock";

const slack = await SlackMock.start({ port: 0, manifest: "slack-manifest.json" });
const app = new App({
  token: slack.env.SLACK_BOT_TOKEN,
  appToken: slack.env.SLACK_APP_TOKEN,
  socketMode: true,
  clientOptions: { slackApiUrl: slack.env.SLACK_API_URL },
});
await app.start();
await slack.waitForConnection();

const ask = await slack.postMessage({ channel: "general", user: "alice", text: `<@${slack.bot.userId}> hi` });
const reply = await slack.waitForMessage({ channel: "general", thread_ts: ask.ts, from: "bot" });
```

What tests can do:

| humans do | `postMessage` (text, thread, files), `editMessage`, `deleteMessage`, `addReaction`, `slashCommand`, `clickButton`, `submitView`, `startAssistantThread`, `changeAssistantContext`, `addUser`, `addChannel`, `openDm`, `invite` |
|---|---|
| observe | `messages`, `thread`, `ephemeralMessages`, `findMessages`, `waitForMessage`, `apiCalls`, `waitForApiCall`, `deliveries` (every envelope and its ack), `assistantThread` |
| break things | `injectFault({ method, error, httpStatus, retryAfterSec, extra })`, `disconnectSockets("refresh_requested")`, options `ackTimeoutMs`, `maxRetries`, `triggerIdTtlMs`, `echoBotMessages`, `subscribedEvents` |

The same operations exist over HTTP under `/mock/*` for use from another
process (see `docs/design.md`).

## Slack behaviour that is modelled

- Socket Mode: `apps.connections.open`, `hello`, envelopes for `events_api`,
  `slash_commands` and `interactive`, acks with response payloads,
  redelivery with `retry_attempt` when an envelope is not acked, server
  pings, `disconnect` messages, reconnects.
- Events: `message` (channels, groups, im), `app_mention`, `message_changed`,
  `message_deleted`, `file_share`, `reaction_added/removed`,
  `member_joined_channel`, `assistant_thread_started`,
  `assistant_thread_context_changed`. The bot's own messages are echoed back
  like Slack does (Bolt's `ignoreSelf` drops them).
- Web API: auth, chat (post, update, delete, ephemeral, permalink, streams),
  conversations (list, info, create, join, invite, archive, history, replies,
  members, open), users (info, list, lookupByEmail), reactions, files
  (info, upload v2 flow, download with bearer token), views (open, update,
  push), assistant.threads (status, title, prompts), pins, bots, team.
  Errors come back as `{ ok: false, error }` with the real codes
  (`not_in_channel`, `already_reacted`, `message_not_found`, `name_taken`,
  `expired_trigger_id`, `message_not_in_streaming_state`, ...).
- Slash command and interactive `response_url`s are served by the mock
  (`ephemeral` / `in_channel`, `replace_original`, `delete_original`).

## Commands

```bash
bun test                      # unit and integration tests (real Bolt client)
bun run test:e2e              # boots ../agent-swarm against the mock (AGENT_SWARM_REPO to override; needs agent-swarm PR #1310)
bun run typecheck
bun run lint
bun run build                 # dist/ (JS for Bun + .d.ts). CI publishes to npm when the version in package.json changes on main
```

## Hosted demo

https://demo.slack-mock.dev runs `scripts/demo-server.ts`: the mock plus a small
demo bot (`scripts/demo-bot.ts`) in one container, deployed to Fly.io from
`main` by `.github/workflows/deploy.yml` (`fly.toml`, `Dockerfile`). State
lives in a JSONL journal on a volume and resets daily. Run it yourself:

```bash
docker build -t slack-mock-demo . && docker run -p 8080:8080 -e ADMIN_AUTH=demo:secret slack-mock-demo
```

`PUBLIC_URL`, `ADMIN_AUTH` (basic auth for the UI and `/mock/*`), `DATA_FILE`,
`RESET_EVERY_HOURS` and `MANIFEST` configure it. The same knobs exist on the
CLI (`--public-url`, `--auth`) and as `SlackMockOptions` (`publicUrl`, `adminAuth`).

The same image also serves a workspace for an *external* bot, the Agent Swarm demo at
https://swarm-demo.slack-mock.dev (`fly.swarm.toml`, app `slack-mock-swarm`). Knobs that make
that possible, all read by `scripts/demo-server.ts`:

| Env | Effect |
|---|---|
| `DEMO_BOT=off` | Skip the built-in demo bot; some other Bolt app connects over Socket Mode. |
| `SLACK_MOCK_BOT_TOKEN`, `SLACK_MOCK_APP_TOKEN` | The tokens the app must present (`botToken` / `appToken` options). The defaults are public, so set these on any shared host. |
| `APP_NAME` | Bot display name (`appName`). |
| `SEED_FILE` | JSON with `users`, `channels`, `messages` and `driver.prompts` (`scripts/seed.ts`); replaces the built-in `#general` and is applied whenever the journal has no channels, so the workspace comes back after every reset. `seeds/agent-swarm-demo.json` is the shipped example. |
| `UI_PUBLIC=true` | Keep `/` and `/c/...` readable without credentials while `ADMIN_AUTH` still gates `/mock/*` (`publicUi` option). |
| `DRIVER_INTERVAL_MINUTES` | Every N minutes post the next `driver.prompts` entry as that user, mentioning the bot, while an app is connected (`scripts/driver.ts`). `0` disables it. |

## Docs

- `skills/slack-mock/SKILL.md`: how to use the package from another repo (agents and humans).
- `docs/design.md`: architecture, decisions, status.
- `docs/research/`: the research behind it (agent-swarm's inbound/outbound
  Slack surface, Bolt and socket-mode internals, payload shapes, protocol
  docs and prior art, e2e conventions, Block Kit surface).
