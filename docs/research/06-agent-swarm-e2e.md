# R6 — Booting agent-swarm against the mock: boot sequence, env, prior conventions

Scope: exactly how an E2E test would boot agent-swarm against slack-mock, what env is minimally
required, how far a task can get without a real LLM provider, existing Slack test doubles and
their gaps, how `bun test` is run in this repo, and where an e2e script should live.

All line numbers are from `/Users/taras/Documents/code/agent-swarm` (working tree at research
time, 2026-09-03).

## 0. The one finding that gates everything else: agent-swarm cannot be pointed at a mock Web API URL today

`src/slack/app.ts:44-49` constructs Bolt like this:

```ts
app = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
  logLevel: process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
});
```

No `clientOptions` is passed. Tracing where that would matter:

- `@slack/web-api`'s `WebClient` constructor (`node_modules/@slack/web-api/dist/WebClient.js:137`)
  defaults `slackApiUrl` to `'https://slack.com/api/'` and it is **only** settable via the
  constructor's `webClientOptions.slackApiUrl` — there is no environment variable read anywhere
  in `@slack/web-api`.
- The same file explicitly disables axios's automatic `HTTP_PROXY`/`HTTPS_PROXY` env-var proxying:
  `proxy: false` at `WebClient.js:177`, with a comment saying to use the `agent` option instead
  (`WebClient.js:173-176`).
- `@slack/bolt`'s `App` constructor (`node_modules/@slack/bolt/dist/App.js:133`) builds its main
  `this.client = new WebClient(token, this.clientOptions)` from the `clientOptions` constructor
  arg — which agent-swarm never passes, so it's `{}` (`App.js:116`).
- The **same** `this.clientOptions` object is threaded into `installerOptions.clientOptions`
  (`App.js:148`) → `SocketModeReceiver`'s constructor (`bolt/dist/receivers/SocketModeReceiver.js:31`)
  → `new SocketModeClient({ clientOptions: installerOptions.clientOptions })`
  (`SocketModeReceiver.js:102`) → that client's own internal `WebClient`
  (`SocketModeReceiver.js:107`), which is the client that calls `apps.connections.open` to fetch
  the WSS URL (`SocketModeReceiver.js:223`).

So **both** the REST Web API traffic (`chat.postMessage`, `reactions.add`, etc.) and the
`apps.connections.open` call that bootstraps the WebSocket all go through `WebClient` instances
whose base URL is hard-pinned to `https://slack.com/api/`, and there is no proxy/env escape
hatch — Bolt's `clientOptions.slackApiUrl` is the only lever, and agent-swarm's `src/slack/app.ts`
does not expose it.

**Implication for the mock:** without a source change in agent-swarm, redirecting Bolt's traffic
to a local mock requires network-level interception (hosts-file entry for `slack.com` /
`wss-primary.slack.com` pointed at 127.0.0.1, mock terminating TLS with a cert trusted via
`NODE_EXTRA_CA_CERTS`, since `NODE_TLS_REJECT_UNAUTHORIZED=0` would also work but is a blunter
hammer and affects every other outbound TLS call the process makes). That is fragile and CI-hostile
compared to the one-line, additive, backward-compatible fix:

```ts
// src/slack/app.ts
app = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
  logLevel: ...,
  clientOptions: process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : undefined,
});
```

This task's instructions forbid editing agent-swarm, so this is **not** applied — it's flagged
here as the concrete, minimal patch a future plan will need to propose and get approved before a
true socket-mode E2E is possible. Everything below (env vars, boot sequence, test conventions)
is written assuming this patch (or an equivalent) lands; where it changes the picture I call it
out explicitly. I did not find any existing `SLACK_API_URL`-shaped escape hatch already in the
codebase (`grep -rn "slackApiUrl\|SLACK_API_URL\|clientOptions" src/slack/*.ts src/*.ts` — no hits).

## 1. Boot sequence: where Slack starts relative to everything else

`src/http.ts` (the `start:http` entrypoint) is a two-line file:

```ts
import "./utils/internal-ai/register-bedrock.ts";
import "./http/index";
```

`src/http/index.ts` runs top-level `await`s in this order before `httpServer.listen(...)`:

1. `loadGlobalConfigsIntoEnv(false)` (`http/index.ts:522`) — hydrates `process.env` from the
   `swarm_config` DB table (existing env wins at this stage). This is the point the DB is first
   touched; `initDb()`/`getDb()` (`src/be/db.ts:264`, `:479`) run lazily on first
   `getDbClient()`/`getSwarmConfigs()` call, not as an explicit separate boot step — there's no
   standalone "init DB" call before this.
2. `seedLegacyCapabilitiesConfig()`, pricing seed + refresh loop, RBAC seed sync, built-in entity
   seeders, RBAC audit sink wiring (`http/index.ts:530-580`) — all before `.listen()`.
3. `httpServer.listen(port, async () => { ... })` — **everything integration-related, including
   Slack, happens inside the listen callback**, i.e. after the HTTP server is already accepting
   connections:
   - `initTelemetry(...)` (`http/index.ts:614`)
   - `await startSlackApp();` (`http/index.ts:626`) — **first Slack touch point**
   - `startQueueStallAlarm()`, `initGitHub()`, `initGitLab()`, `initAgentMail()`,
     `await initLinear()`, `await initJira()`, `await initWorkflows()`,
     `startScriptRunSupervisor(...)`, scheduler, heartbeat, OAuth keepalive/sweep, memory GC, DB
     retention (`http/index.ts:628-696`, in that order).

`src/slack/app.ts` (`initSlackApp` / `startSlackApp`, full source read):

```ts
export async function initSlackApp(): Promise<App | null> {
  if (initialized) return app;               // idempotent guard
  initialized = true;
  if (SLACK_DISABLE === "true"/"1") return null;
  if (!botToken || !appToken) return null;    // silently disabled, not fatal
  const socketModeBlockReason = getSlackSocketModeBlockReason(process.env);
  if (socketModeBlockReason) { console.error(...); return null; }  // NOT fatal — logs and returns null
  app = new App({ token: botToken, appToken, socketMode: true, logLevel });
  registerMessageHandler(app); registerCommandHandler(app); registerActionHandlers(app);
  app.assistant(createAssistant());
  return app;
}

export async function startSlackApp(): Promise<void> {
  if (!app) await initSlackApp();
  if (app) {
    if (isSlackRenderV2Enabled()) await ensureSlackRenderV2Activation();
    await app.start();                        // opens the Socket Mode WS connection
    await startTaskWatcher();                  // starts the 3s poll loop (src/slack/watcher.ts:507)
  }
}
```

Nothing about Slack failing to connect is fatal to server boot — a bad/unreachable
`SLACK_APP_TOKEN` would make `app.start()` (Bolt's `SocketModeClient.start()`) reject/retry
internally; agent-swarm doesn't catch that specific await, so **an unreachable Socket Mode
endpoint could make `startSlackApp()` throw inside the `.listen()` callback**, which is inside an
async IIFE-ish listen handler, not wrapped in try/catch at that call site (`http/index.ts:593-700`
has no surrounding try/catch around the whole listen-callback body). This means: the mock's
WebSocket endpoint needs to at least accept the connection and answer `apps.connections.open`
promptly, or server boot for a Slack-enabled test process can hang/reject.

## 2. NODE_ENV and the Socket Mode dev guard

`src/slack/socket-mode-guard.ts` (full file, 10 lines):

```ts
export const SLACK_DEV_SOCKET_MODE_OPT_IN = "SLACK_ALLOW_DEV_SOCKET_MODE";
export function getSlackSocketModeBlockReason(env): string | null {
  if (env.NODE_ENV !== "development") return null;
  if (isEnvFlagEnabled(SLACK_DEV_SOCKET_MODE_OPT_IN, false, env)) return null;
  return "NODE_ENV=development marks this as a dev/throwaway run";
}
```

Confirmed by `src/slack/socket-mode-guard.test.ts:5-22`: the guard **only** fires when
`NODE_ENV === "development"` exactly. Any other value (`"test"`, `"production"`, unset) passes
with no opt-in needed.

Two package.json scripts matter here:
- `"start:http": "NODE_ENV=development bun --expose-gc src/http.ts"` (`package.json:117`) — the
  normal local-dev command, which **would** block Socket Mode unless
  `SLACK_ALLOW_DEV_SOCKET_MODE=true` is also set.
- Running `bun src/http.ts` directly (not via the `start:http` wrapper script) does **not** set
  `NODE_ENV=development` — it inherits whatever the parent shell/process has. `bun test` itself
  sets `NODE_ENV=test` for the test process (verified empirically:
  `bun test /tmp/envcheck.test.ts` printed `NODE_ENV= test`), and a spawned child that does
  `env: { ...process.env, ... }` inherits that.

**Practical rule for the mock's e2e harness:** spawn `bun src/http.ts` (not `bun run start:http`),
and either leave `NODE_ENV` unset/inherited or explicitly set `NODE_ENV=test` in the spawn env.
Do **not** set `NODE_ENV=development` unless you also set `SLACK_ALLOW_DEV_SOCKET_MODE=true`. This
matches exactly what `src/tests/rbac-e2e-helpers.ts` does for its own subprocess (see §5) —
it never touches `NODE_ENV` and relies on the ambient `bun test` value.

## 3. Minimal env to boot the API server with Slack "enabled" against a mock

From `initSlackApp()` plus `getApiKey()` (`src/utils/api-key.ts:16`) plus the capability table
(`src/server.ts:183-224`, `"slack"` is in `DEFAULT_CAPABILITIES`, no extra `CAPABILITIES` env
needed) plus `.env.example:66-73` / `docs-site/.../slack-integration.mdx:30-38`:

| Var | Value for mock | Why |
|---|---|---|
| `SLACK_BOT_TOKEN` | any non-empty string, e.g. `xoxb-mock` | only checked for truthiness at `app.ts:31`; format is never validated by Bolt or agent-swarm |
| `SLACK_APP_TOKEN` | any non-empty string, e.g. `xapp-mock` | same — presence-only check (`app.ts:31`); Bolt's own check is also presence-only (`App.js:721-724`) |
| `SLACK_DISABLE` | unset (or `false`) | must NOT be `"true"`/`"1"` or Slack is skipped entirely (`app.ts:23`) |
| `SLACK_SIGNING_SECRET` | unset | explicitly optional for Socket Mode (`.env.example:70`, docs `:32`) — the mock never needs to verify a signature |
| `NODE_ENV` | unset or `"test"` | must not be `"development"` without the opt-in (§2) |
| `SLACK_ALLOW_DEV_SOCKET_MODE` | not needed if `NODE_ENV≠development` | only relevant if the harness insists on `NODE_ENV=development` |
| `DATABASE_PATH` | scratch tmp path, e.g. `mkdtemp()/db.sqlite` | isolates from the repo's `agent-swarm-db.sqlite`; see §5 for the exact helper |
| `PORT` | an OS-assigned free port | never hard-code (`getFreePort()` from `src/tests/test-net.ts:13`) |
| `API_KEY` / `AGENT_SWARM_API_KEY` | any fixed string, e.g. `e2e-slack-key` | `getApiKey()` precedence is `AGENT_SWARM_API_KEY > API_KEY`; set both to the same value defensively (mirrors `rbac-e2e-helpers.ts:70-71`) |
| `SLACK_API_URL` (hypothetical) | `http://localhost:<mockPort>/api/` | **only exists if the §0 patch lands** — otherwise there is no way to redirect Bolt's Web API base URL |
| `GITHUB_DISABLE`, `JIRA_DISABLE`, `LINEAR_DISABLE` | `"true"` | not under test; keeps boot fast and avoids unrelated network calls, matches every existing e2e script's pattern |
| `OAUTH_KEEPALIVE_DISABLE` | `"true"` | same reasoning, matches `rbac-e2e-helpers.ts:73` |

**Can the server boot without an LLM provider?** Yes, unconditionally. Nothing in the
`src/http/index.ts` boot sequence (§1) reads `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or any
provider credential — those are only consumed by worker-side code (`src/commands/runner.ts`,
`src/providers/*`), which runs in a *separate* Docker container process, never in the API server.
`grep -n "requiredEnv\|ANTHROPIC_API_KEY\|OPENROUTER" src/http/index.ts` returns no hits. This is
also implicit in every existing e2e script (`e2e-provider-test.ts`, `rbac-e2e-helpers.ts`) — none
of them sets a provider key to boot the API server.

**Can a task complete quickly with a fake/"echo" agent?** No such adapter exists.
`src/providers/index.ts:24`'s `createProviderAdapter(provider)` only recognizes the real harnesses
(`claude-adapter.ts`, `codex-adapter.ts`, `devin-adapter.ts`, `pi-mono-adapter.ts`,
`opencode-adapter.ts`, `claude-managed-*`); `grep -rn "echo\|fake.*provider\|mock.*provider"
src/providers/*.ts` returns nothing. `scripts/e2e-provider-test.ts:170-180` explicitly documents
this gap in its own comment: *"Actually running the provider session requires LLM credentials and
the provider SDK... For CI, mark this as a note rather than a failure."* So there is no built-in
echo/no-op harness to lean on.

**The workaround that avoids both a real LLM and a real worker container:** `POST
/api/tasks/{id}/finish` (`src/http/tasks.ts:482-505`) is documented as the "runner endpoint" —
it's what a real worker calls when it's done, but nothing stops an e2e script from calling it
directly. Preconditions read from the handler body (`tasks.ts:1330-1420`):
- `task.agentId` must be unset or equal to the caller's `X-Agent-ID` (`auth: { apiKey: true,
  agentId: true }`), else `403`.
- `task.status` must be `"in_progress"`, else it's a silent no-op (`{success:true,
  alreadyFinished:true}`).
- `body: { status: "completed"|"failed", output?, failureReason?, force? }`.

To get a task into `in_progress` without a real worker, `GET /api/poll` (`src/http/poll.ts:162`,
`:400`) is what a real worker's poll loop calls; it flips a `pending` task assigned to the polling
agent into `in_progress` via `startTask(pendingTask.id)`. This exact trick — `poll` to flip a task
to `in_progress` without a worker, then drive it through terminal states via HTTP — is precisely
what `scripts/e2e-des523-crash-recovery-api.ts:17-19` already does for its own (non-Slack) purposes,
so it's a proven, in-repo pattern, not a novel idea.

**Net effect:** a Slack-triggered task can be driven all the way to "completed" and back into a
Slack reply **without any LLM provider and without any Docker worker**, using only:
register a fake worker agent → `GET /api/poll` (as that agent) → `POST
/api/tasks/{id}/finish {status:"completed", output:"..."}`. `src/slack/watcher.ts:507`
(`startTaskWatcher(intervalMs = 3000)`) polls `getCompletedSlackTasks()` every 3s
(`watcher.ts:29,565`) and posts the reply — it reads task state from the DB directly, it does not
care whether a real worker process produced that state.

## 4. Recommended e2e scope for R6's purposes

Given §0 and §3, two tiers are realistic:

1. **Tier 1 — "task created + ack posted" (no source patch needed if network interception is used,
   or trivial once §0's patch lands):** inject a mock user message over the Socket Mode WS →
   assert agent-swarm creates a task (`POST /api/tasks` observed, or read back via `GET
   /api/tasks/{id}`) and that the `eyes` reaction / initial `say()` reply lands in the mock's Web
   API (`reactions.add` / `chat.postMessage` calls recorded, per `src/slack/handlers.ts:656,
   661-684` — both an `ackSlackMessage(...)` reaction call and a `say({...})` text reply happen on
   ingest, so the mock must support recording **both**).
2. **Tier 2 — "task created, ack posted, and a reply after completion":** additionally drive the
   task to `completed` via the poll+finish trick in §3, then assert the watcher's follow-up
   Block Kit message (`chat.postMessage`/`chat.update` with the tree/completion blocks — see
   research doc 07) shows up in the mock within the ~3s watcher tick.

Tier 2 does not require Docker or an LLM key at all — it's pure HTTP-against-the-real-API-server
plus the mock. This should be the target scope for slack-mock's own E2E suite; it's a strict
superset of Tier 1 and exercises the exact watcher/DB code path real usage depends on.

## 5. How the real-server-as-subprocess pattern already works in this repo

There is no Slack-specific e2e today (see §7), but there is a well-established, repo-idiomatic
pattern for spawning the *real* `src/http.ts` server from inside a `bun:test` file and driving it
over HTTP: `src/tests/rbac-e2e-helpers.ts`, consumed by `src/tests/rbac-wire-e2e.test.ts` (in the
default `bun test:root` run) and the env-gated `rbac-lifecycle-e2e.test.ts`. Full relevant excerpt
(`rbac-e2e-helpers.ts:52-95`):

```ts
export async function spawnSwarmServer(opts: {
  dbPath: string; logPath: string; env?: Record<string, string>; waitForListen?: boolean;
}): Promise<SwarmServer> {
  const port = await getFreePort();
  const logFd = openSync(opts.logPath, "a");
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: REPO_ROOT,
    stdout: logFd, stderr: logFd,
    env: {
      ...process.env,
      DATABASE_PATH: opts.dbPath,
      AGENT_FS_LOCAL_DIR: join(dirname(opts.dbPath), "fs"),
      API_KEY: E2E_API_KEY, AGENT_SWARM_API_KEY: E2E_API_KEY,
      PORT: String(port),
      SLACK_DISABLE: "true", GITHUB_DISABLE: "true", JIRA_DISABLE: "true", LINEAR_DISABLE: "true",
      OAUTH_KEEPALIVE_DISABLE: "true",
      RBAC_AUDIT_DISABLED: "", RBAC_AUDIT_FLUSH_MS: "",
      RBAC_ENABLED: "false",
      ...opts.env,
    },
  });
  const server: SwarmServer = {
    proc, port, base: `http://localhost:${port}`, dbPath: opts.dbPath, logPath: opts.logPath,
    async stop() { proc.kill("SIGTERM"); await proc.exited; return proc.exitCode; },
  };
  if (opts.waitForListen !== false) await waitForListen(server);
  return server;
}
```

`waitForListen` (`rbac-e2e-helpers.ts:114-124`) polls `GET /docs` every 200ms up to a 90s deadline
(`waitForListen(server, deadlineMs = 90_000)`), and separately raises immediately if
`proc.exitCode !== null` (crashed before listening) rather than waiting out the full deadline.
`src/tests/test-net.ts` has the generic, non-RBAC-specific versions of the same primitives:
`getFreePort()` (:13), `listenOnFreePort(server)` (:35, for in-process `node:http` servers, not
needed here), `waitForServer(url, timeoutMs=60_000)` (:56, polls until 2xx), and the shared
`SERVER_BOOT_HOOK_TIMEOUT_MS = 90_000` constant (:71) that callers must pass as their `beforeAll`
hook timeout so the hook itself doesn't time out before `waitForServer` gives up.

This is the pattern slack-mock's own e2e harness should mirror: `Bun.spawn(["bun", "src/http.ts"],
{ cwd: <agent-swarm repo root>, env: {...} })`, poll a readiness endpoint, `SIGTERM` + `await
proc.exited` to stop, and clean up the scratch `DATABASE_PATH` (`.sqlite`, `-wal`, `-shm`) files
afterward — exactly as `scripts/e2e-provider-test.ts:86-100` and `rbac-e2e-helpers.ts` both do.

For a **standalone script** (not a `bun:test` file — see §8 for the location recommendation),
`scripts/e2e-provider-test.ts` is the closer template: manual `waitForApi()` polling `/health`
(not `/docs`), `process.on("SIGINT"/"SIGTERM", cleanup)` handlers, and an idempotent `cleanup()`
guarded by a `cleaningUp` flag (`e2e-provider-test.ts:78-113`).

Health/readiness endpoint note: `rbac-e2e-helpers.ts` polls `/docs`, `e2e-provider-test.ts` polls
`/health`. Either works as a "server is listening" signal; `/health` is semantically closer to a
true readiness probe and is what `docker-entrypoint.sh`'s `wait_for_api_ready` also polls
(`LOCAL_TESTING.md:98`). Prefer `/health` for a new script.

## 6. Test isolation, timeouts, serial vs parallel

From `bunfig.toml` and `LOCAL_TESTING.md:14-38` (already largely quoted verbatim there, cross-
checked directly against the config file):

- `[test] maxConcurrency = 1` and `preload = ["./src/tests/preload.ts"]` — every test file, run
  serially within its process by default. `bun run test:root -- --parallel=4` runs each test
  **file** in its own worker process (four at a time), which is what CI uses
  (`.github/workflows` — not re-read here, per `LOCAL_TESTING.md:24-27`).
- No global retry (`bunfig.toml` has no `[test] retry` key) — a flaky/timing-sensitive test must
  opt in per-test with `test(name, fn, { retry: 2 })` and a comment.
- Each test file that touches the DB directly uses an isolated `./test-<name>.sqlite`, calling
  `initDb()`/`closeDb()` in `beforeAll`/`afterAll` and deleting the `.sqlite`/`-wal`/`-shm` trio in
  `afterAll`. **This does not apply the same way to a subprocess-based e2e** — when the test spawns
  a real `bun src/http.ts` child, the *child* owns the DB (via its own `DATABASE_PATH`), and the
  parent test process does not call `initDb()` itself; it can optionally open a **readonly**
  `bun:sqlite` connection to the same file for assertions (WAL mode allows the cross-process read),
  which is exactly what `rbac-wire-e2e.test.ts:18,32` do (`import { Database } from "bun:sqlite"`
  + `readAuditRows`).
- `src/tests/preload.ts`'s migration-template fast path (`__testMigrationTemplate` global,
  `AGENT_SWARM_TEST_TEMPLATE_CACHE`) only benefits **in-process** `initDb()` calls in the *same*
  bun process that ran the preload script. A spawned `bun src/http.ts` child is a fresh process
  without that global set, so it always runs the full migration set on boot (`LOCAL_TESTING.md:31`
  confirms the cache is keyed and lives under `$TMPDIR`, but that's irrelevant to a child process
  that never imports `src/tests/preload.ts`). Budget for full-migration boot time, not the
  fast-path time, when picking a readiness timeout — `SERVER_BOOT_HOOK_TIMEOUT_MS = 90_000`
  (§5) is the number already used for exactly this scenario.
- **Never `Bun.spawnSync` in a test, and never leave the default 10s test timeout for a
  spawn-based test** (`runbooks/testing.md` hard rule #5) — use `runChild()`/`expectChildOk()`
  from `src/tests/test-proc.ts` for short-lived spawns (30s hard ceiling,
  `CHILD_PROCESS_TEST_BUDGET_MS = 35_000` as the test's own timeout arg), or the
  `spawnSwarmServer`/`waitForServer` pattern from §5 for a long-lived server child. A Slack e2e
  spawning the full server is a long-lived-child case, not a `runChild()` case.
- `setDefaultTimeout(120_000)` at the top of `rbac-wire-e2e.test.ts:35` is the file-level pattern
  for a `bun:test` file whose *individual tests* (not just the `beforeAll` hook) need more than
  bun's default 5s per-test timeout because they're making real HTTP round-trips against a
  subprocess.
- Never hard-code a port — literal ports collide under `--parallel=4` where multiple files run
  concurrently in separate processes but could pick the same literal. Always `getFreePort()`.
- `Authorization: Bearer <key>` and `X-Agent-ID: <uuid>` are the two headers every authenticated
  call needs; agent IDs **must** be valid UUIDs (`crypto.randomUUID()` or fixed UUID-shaped
  literals like `rbac-e2e-helpers.ts`'s `LEAD`/`WORKER_A`/`WORKER_B`) — several MCP/HTTP output
  schemas pin agent-id fields to UUID and reject slugs post-write (`AGENTS.md:293`-equivalent hard
  rule, also independently visible in `rbac-e2e-helpers.ts`'s constant UUIDs).

## 7. Existing Slack test doubles: what they fake and what they cannot cover

27 files under `src/tests/slack-*.test.ts` plus `src/slack/handlers.test.ts`,
`src/slack/event-dedup.test.ts`, `src/slack/socket-mode-guard.test.ts`. None of them opens a real
Bolt `App`, a real Socket Mode WebSocket, or a real Web API HTTP call. Two faking styles, both
hand-rolled (no `nock`, `msw`, or Slack-specific test-double library found anywhere in
`package.json`):

**Style A — call the exported handler-registration function directly with a stub "app":**
`src/slack/handlers.test.ts:449-457`:

```ts
registerMessageHandler({
  event: (eventType, handler) => { if (eventType === "message") messageHandler = handler; },
} as never);
```

...then invoke the captured `messageHandler` with a synthetic Bolt-event-shaped object built by
hand (`handlers.test.ts:489-499`):

```ts
await messageHandler!({
  event: { type: "message", channel: "D_THREAD_ACK_TEST", thread_ts: "...", ts: "...",
            text: "<@U_SWARM_BOT> one more follow-up", user: "U_HUMAN" },
  body: { event_id: "evt_thread_ack_completed_001" },
  client,   // hand-rolled object below, not a real WebClient
  say: mock(async () => {}),
});
```

The `client` passed in (`handlers.test.ts:429-438`) only implements the three methods that
specific test needs: `auth.test`, `conversations.replies`, `reactions.add` — everything else on
a real `WebClient` (retry/backoff, rate-limit handling, error-shape normalization, `files.*`,
`chat.*`) is simply absent, so any handler code path that touches an unstubbed method would throw
`undefined is not a function`, not a Slack-shaped error.

**Style B — `mock.module("../slack/app", () => ({ getSlackApp: () => ({ client: {...} }) }))`:**
used in `src/tests/slack-watcher.test.ts:511-527` and `src/tests/slack-upload-file.test.ts:21-26`.
This replaces the entire `src/slack/app` module (so `getSlackApp()` returns a fake `{ client:
{...} }`) for the whole test file, again exposing only the specific nested methods under test
(`chat.update`, `chat.postMessage`, `assistant.threads.setStatus`, `reactions.add/remove`,
`files.uploadV2`, per file). The DB layer in these tests is real (`createAgent`,
`createTaskExtended` from the DB module), so what's actually under test is
"DB state → watcher query → Block Kit builder → *these specific* WebClient method calls", which is
valuable but entirely one-directional (agent-swarm → Slack); nothing simulates Slack → agent-swarm
except direct synthetic handler calls (Style A).

**`event-dedup.test.ts`** (`src/slack/event-dedup.test.ts`, full file) unit-tests `wasEventSeen()`
in complete isolation — an in-memory TTL cache keyed by `event_id` string. It never exercises a
real Socket Mode redelivery (Slack's actual retry envelope over the WS, with `retry_attempt`/
`retry_reason`), only the string-keyed cache logic with hand-picked IDs like `"Ev0001"`.

**`socket-mode-guard.test.ts`** (already quoted in full in §2) is pure unit testing of the guard
function with a literal `env` object — no App, no process boot.

**What none of these 27 files can cover, that a real socket-mode mock adds:**
1. **Real Bolt dispatch order/middleware/ack semantics** — Style A calls the captured handler
   function directly, bypassing Bolt's own event routing, `ignoreSelf` bot-message filtering,
   `ack()`/timeout semantics for slash commands and block actions, and the actual envelope
   ack/nack protocol Socket Mode requires (`envelope_id` roundtrip) — none of that code path is
   exercised at all today.
2. **Real WebClient behavior** — retry policy (`retryConfig`), rate-limit (`429` + `Retry-After`)
   handling, `rejectRateLimitedCalls`, actual JSON error shapes (`{ok:false, error:"..."}`) for
   every method, not just the 3-6 methods each test file happened to stub.
3. **Wire-format fidelity** — the hand-typed event/body payloads in Style A are whatever the test
   author guessed Slack sends; a real Slack event (or a mock replaying real Slack event shapes)
   could catch missing/extra fields, e.g. `event.channel_type`, `authorizations[]`,
   `event_context`, none of which appear in the hand-rolled fixtures.
4. **Cross-handler interaction** — `registerMessageHandler`, `registerCommandHandler`,
   `registerActionHandlers`, and `app.assistant(...)` are registered together in `initSlackApp()`
   but never booted together in any test; each test file exercises exactly one handler group in
   isolation.
5. **The full round trip through HTTP** — `POST /api/tasks`, `GET /api/poll`, `POST
   /api/tasks/{id}/finish`, and the watcher's DB polling (§3) are never chained end-to-end with a
   Slack-originated message in any existing test; DB state is seeded directly
   (`createTaskExtended(...)` with `source: "slack"` fields pre-set) rather than being produced by
   an inbound Slack event.
6. **Reconnection/redelivery behavior** — Socket Mode's automatic reconnect
   (`autoReconnectEnabled`, `SlackWebSocket.js`) and Slack's at-least-once delivery guarantee
   (which is what `event-dedup.ts` exists to handle) are never driven by an actual reconnecting
   client anywhere in the suite.

## 7b. Prior attempts / conventions from `thoughts/`: every past Slack E2E was manual, against real Slack, no mock

Four documents in `thoughts/` speak to "how has Slack been E2E-tested before" — none of them describe or
even gesture at an automated mock. Read in full:

- **`thoughts/taras/research/2026-03-16-slack-thread-followups-e2e.md`** (55 lines, `status: complete`) —
  a **manual** E2E test log for a thread-follow-up fix. Setup (lines 11-15): `bun run start:http` + a
  single **real** Docker lead container (`.env.docker-lead`, `AGENT_ROLE=lead`) + `ADDITIVE_SLACK=true`,
  no mock, no automation — the tester typed `@bot say hello` into an actual Slack channel (`C0A4BSMEE7`)
  and DM (`D0AKYSSHR0`) and manually checked boxes. Line 44-47 explicitly notes one scenario ("worker task
  notifications") was **not tested** because "no workers in setup" — i.e. this manual-Slack approach
  already hits a wall exactly where a Docker worker would be needed, which is the same wall this task's
  Tier 2 (§4) sidesteps via poll+finish instead of a real worker.
- **`thoughts/taras/plans/2026-04-09-slack-message-deduplication.md`** (787 lines) — the fullest example of
  the repo's actual "Manual E2E" convention (the one this task's own instructions require every plan to
  end with). Its `## Manual E2E` section (lines 736-759) is: `bun run start:http`, build+run **two real
  Docker containers** (`e2e-lead`, `e2e-worker`, real images, real `.env.docker-lead`/`.env.docker`), curl
  `/api/agents` to confirm they registered, then **five manually-typed Slack scenarios** ("`@bot "What's
  2+2?"`", DM the bot, cancel via button, etc.) with no scripted assertions — a human reads the Slack UI.
  A `## Post-Plan Fixes (E2E Testing)` section (lines 766-776, dated the same day) documents **bugs found
  only by this manual pass** that unit tests missed: a batching-message-reuse bug, a
  child-nesting race condition in the watcher's `parentTaskId` walk, a `send-task` auto-default gap, and a
  direct-assignment-path field-name bug (`parentTaskId` vs `effectiveParentTaskId`) — concrete evidence
  that Slack's async, multi-process, timing-sensitive paths (exactly what an automated mock would target)
  are where this repo's manual-only process has repeatedly missed bugs that unit tests didn't catch.
  Cross-cutting logging rule (line 13): every phase must add `console.log("[Slack]")` at key decision
  points specifically "to enable E2E debugging via `bun run pm2-logs` or Docker logs" — i.e. the existing
  debugging story for Slack E2E is grep-the-logs, not structured assertions; a mock with a queryable JSONL
  log (this task's own storage requirement) is a direct upgrade on that.
- **`thoughts/taras/plans-yolo/2026-08-20-slack-channel-lifecycle.md`** (42 lines) — a small, `status: done`
  yolo-plan for channel create/invite/archive MCP tools. Its `## Verification` (lines 29-42) is **unit
  tests only** (`bun run test:root -- src/tests/slack-channel-lifecycle.test.ts` and three RBAC/annotation
  test files) — no Manual E2E section at all, confirming that for lower-risk/non-message-flow Slack
  changes, the convention has been to skip E2E entirely, not even the manual-Docker-lead kind.
- **`thoughts/shared/research/2025-12-18-slack-integration.md`** (442 lines) — pre-implementation design
  research, dated *before* Slack integration existed (its own summary, line 40: *"No existing Slack code
  exists in the codebase"*). It describes a raw `src/http.ts` `createServer` HTTP layer and a 3-table
  schema (`agents`/`agent_tasks`/`agent_log`) that **no longer match current code** — today's server is
  `src/http/index.ts` (a modular router with dozens of files under `src/http/`), and the DB layer has
  grown far beyond 3 tables. This doc is superseded and historical only; do not use it for current
  boot-sequence, schema, or endpoint facts (§0-§6 above supersede it in every particular checked). Its one
  still-relevant artifact is `slack-manifest.json` (scopes/events list, lines 313-329), which is current
  because it's a live config file, not prose describing code.

**Conclusion for slack-mock:** there is no prior automated E2E convention to match — every existing "E2E"
for Slack in agent-swarm has been a human typing into a real Slack workspace against a real Docker lead
(and sometimes a real Docker worker), reading results off the Slack UI or `pm2`/Docker logs, with zero
scripted assertions. slack-mock's own e2e suite (§4-§6, `mockRequirements` below) would be the **first**
automated, assertion-based Slack E2E this codebase has ever had — there's no existing test harness code,
fixture format, or scripted-scenario convention to reuse beyond the non-Slack `rbac-e2e-helpers.ts`
subprocess pattern (§5), which is a different (though structurally analogous) integration.

## 7c. `docker-compose.local.yml` and `Makefile`: two more data points, both confirming "Slack is off by default" and "agent-fs is optional"

- **`docker-compose.local.yml`** (full file read) is a from-source local stack: `minio` + `minio-init` +
  `agent-fs` (image `ghcr.io/desplega-ai/agent-fs:0.13.3`) + `api` (built from the repo `Dockerfile`). The
  `api` service's `environment` block (lines 90-99) hard-codes `SLACK_DISABLE=true` and
  `GITHUB_DISABLE=true` — the maintained "run the whole local stack" compose file deliberately never boots
  Slack at all, reinforcing that there is no compose-based Slack testing path to extend; a slack-mock e2e
  harness is additive, not a variant of an existing one.
- The same compose file's `api` service `depends_on: agent-fs: condition: service_healthy` (lines 86-89)
  might suggest agent-fs is required to boot, but it is **not** a hard runtime dependency: `src/fs/registry.ts:16`
  only switches to the remote `agent-fs` HTTP provider `if (process.env.AGENT_FS_API_URL ...)` is set;
  `src/fs/local-fs-provider.ts:28` is the fallback (`AGENT_FS_LOCAL_DIR ?? DEFAULT_ROOT_DIR`) used whenever
  it isn't. This is exactly the mode `rbac-e2e-helpers.ts` runs in (§5: sets `AGENT_FS_LOCAL_DIR`, never
  `AGENT_FS_API_URL`) and exactly the mode a slack-mock e2e harness should use too — no minio/agent-fs
  Docker services needed for either Tier 1 or Tier 2 (§4).
- **`Makefile`** (4 lines, full file) is just `bun run format && bun run tsc:check && bun run lint && bun
  test` — the repo's single `make`/`all` target. It runs plain `bun test` (not `bun run test:root`, no
  `--parallel`, no shard flags) and has no Docker/e2e target at all. Not a source of e2e conventions beyond
  confirming `bun test` is the base command every wrapper script builds on.

## 8. Where an e2e script for Slack should live, by convention

Two existing conventions in agent-swarm, neither a perfect fit because slack-mock is a **separate**
package:

- `scripts/e2e-*.ts` — standalone bun scripts (`bun scripts/e2e-<name>.ts`), each self-contained
  with its own spawn/wait/cleanup, some requiring Docker (`e2e-docker-provider.ts`) or a running
  external dependency (`e2e-otel-jaeger.ts` presumably needs Jaeger). This is the closer analogue —
  a Docker-dependent e2e script is already an accepted pattern for "needs an external process
  running first."
- `src/tests/*-e2e.test.ts` — `bun:test` files using the `rbac-e2e-helpers.ts` subprocess pattern
  (§5), run as part of (or opted into, via env gate) `bun run test:root`.

Since slack-mock lives in a **separate repo** (`/Users/taras/Documents/code/slack-mock`) and this
task's rules forbid modifying agent-swarm, the e2e test that exercises both packages together must
live in **slack-mock's own repo**, not inside `agent-swarm/scripts/`. It should:

- Mirror the `rbac-e2e-helpers.ts` spawn/wait/cleanup shape (§5), pointing `Bun.spawn`'s `cwd` at
  the agent-swarm checkout path (configurable via an env var such as
  `AGENT_SWARM_REPO_PATH`, since slack-mock's CI would need to check out or reference
  agent-swarm as a sibling — that mechanic is outside R6's scope and belongs to a later plan).
- Use `bun test` (not a standalone script) if slack-mock's own test runner is bun:test-based
  (consistent with agent-swarm's own preference for `bun:test`-based e2e over ad hoc scripts where
  a `beforeAll`/`afterAll` lifecycle is natural) — but a standalone script
  (`scripts/e2e-agent-swarm.ts` inside the slack-mock repo, modeled on
  `scripts/e2e-provider-test.ts`) is equally consistent with agent-swarm's own conventions if
  slack-mock prefers CLI-runnable scripts.
- If the team later wants this e2e to run as part of agent-swarm's own CI (verifying agent-swarm
  against slack-mock on every agent-swarm PR), that requires a **separate, explicit decision and
  PR against agent-swarm** — e.g. adding slack-mock as a dev dependency or a documented
  `docker run`-able image, plus a new `scripts/e2e-slack-mock.ts` there. That is out of scope for
  this research task (which is instructed not to modify agent-swarm) and should be a follow-up
  proposal, gated on the §0 patch being accepted first.

## mockRequirements — the programmatic API the mock should expose to tests

From the e2e perspective (Tier 1 + Tier 2 scope, §4), the mock needs:

1. **Lifecycle**: `start()` / `stop()` — bind an HTTP server (Web API + Socket Mode WS) on a free
   port, return its base URL(s); clean shutdown that closes any open WS connections.
2. **Seed data before boot**: register at least one bot identity (`user_id`, `bot_id`, `team_id`,
   `team.name`, `url`) so `auth.test` (called by Bolt's `App.init()` when `tokenVerificationEnabled`
   is true, the default — `App.js:217-218`) returns a well-formed response; seed at least one
   human user and one channel/DM so inbound-message injection has valid `user`/`channel` IDs to
   reference.
3. **Inject inbound events** (mock → agent-swarm, over the Socket Mode WS): user message
   (`event.type: "message"`, with `app_mention` variant via `<@BOT_ID>` in text), slash command
   invocation, block-action (button click) payload — matching the event/action shapes
   `registerMessageHandler`/`registerCommandHandler`/`registerActionHandlers` expect
   (`src/slack/handlers.ts`, `commands.ts`, `actions.ts`).
4. **Record outbound calls** (agent-swarm → mock, over the Web API HTTP surface): `chat.postMessage`,
   `chat.update`, `reactions.add`/`remove`, `conversations.replies`, `files.uploadV2`, and (if
   `SLACK_RENDER_V2=true` is ever exercised) `chat.startStream`/`appendStream`/`stopStream` — see
   research doc 07 for the full Block Kit surface. Store these as an ordered, queryable JSONL log
   per channel/thread (per this task's own storage requirement).
5. **Query helpers for assertions**: "wait for N messages in thread X" (poll/await, not a fixed
   sleep — the watcher's 3s tick and Bolt's own async dispatch mean a fixed sleep is flaky), "get
   latest message text/blocks in thread X", "get reactions on message Y", "was `auth.test` called
   with token Z" (useful for verifying agent-swarm actually used the mock's token, not a leaked
   real one).
6. **HTML render endpoint**: given a channel or thread ID, render the recorded messages
   (including Block Kit) as HTML for screenshot capture — a read-only projection of the same JSONL
   log used for #4/#5, not a new data path.
7. **Config knob agent-swarm actually needs**: whatever env var ends up wired per §0 (e.g.
   `SLACK_API_URL`) must resolve to the mock's Web API base URL, and the mock's `apps.connections.open`
   response must return a `url` pointing at its own WS endpoint (`ws://` is fine locally — Bolt's
   `SocketModeClient` does not require `wss://` for a non-TLS local URL, though this specific claim
   was not verified against `SlackWebSocket.js` in this pass and should be confirmed by whichever
   research task owns the Socket Mode protocol details).

## envForMock

| Var | Value | Why |
|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-mock` (or any non-empty string) | presence-only check, `src/slack/app.ts:31` |
| `SLACK_APP_TOKEN` | `xapp-mock` (or any non-empty string) | presence-only check, `src/slack/app.ts:31` + Bolt `App.js:721-724` |
| `SLACK_DISABLE` | unset | must not be `"true"`/`"1"`, `app.ts:23` |
| `SLACK_SIGNING_SECRET` | unset | optional for Socket Mode, `.env.example:70` |
| `NODE_ENV` | `test` (or unset) | avoid the dev Socket Mode guard, `src/slack/socket-mode-guard.ts` |
| `DATABASE_PATH` | scratch tmp path per test run | isolation, `src/be/db.ts:479` |
| `PORT` | OS-assigned free port | `src/tests/test-net.ts:13`, never a literal |
| `API_KEY` + `AGENT_SWARM_API_KEY` | same fixed string, e.g. `e2e-slack-key` | `src/utils/api-key.ts:16` precedence |
| `SLACK_API_URL` | `http://127.0.0.1:<mockPort>/api/` | **requires the §0 source patch** — does not exist in agent-swarm today |
| `GITHUB_DISABLE`, `JIRA_DISABLE`, `LINEAR_DISABLE` | `true` | keep boot fast, avoid unrelated integrations, matches `rbac-e2e-helpers.ts` |
| `OAUTH_KEEPALIVE_DISABLE` | `true` | same reasoning |

## Boot steps (concrete, for a Tier 2 e2e run)

1. Start the mock server: bind Web API HTTP + Socket Mode WS on a free port; seed one bot identity,
   one human user, one channel.
2. `mkdtemp()` a scratch dir; compute `DATABASE_PATH=<dir>/db.sqlite`, pick a free `PORT` via
   `getFreePort()`-equivalent.
3. `Bun.spawn(["bun", "src/http.ts"], { cwd: <agent-swarm repo root>, env: { ...process.env,
   PORT, DATABASE_PATH, API_KEY, AGENT_SWARM_API_KEY, SLACK_API_URL: <mock Web API base>,
   SLACK_BOT_TOKEN: "xoxb-mock", SLACK_APP_TOKEN: "xapp-mock", NODE_ENV: "test", GITHUB_DISABLE:
   "true", JIRA_DISABLE: "true", LINEAR_DISABLE: "true", OAUTH_KEEPALIVE_DISABLE: "true" },
   stdout: "pipe", stderr: "pipe" })`.
4. Poll `GET http://localhost:<PORT>/health` until `2xx`, deadline ~90s (`SERVER_BOOT_HOOK_TIMEOUT_MS`
   from `src/tests/test-net.ts:71`); fail fast if `proc.exitCode !== null` before the deadline.
5. Assert the mock observed a Socket Mode connection (its own internal state, e.g. an open WS
   client) and that `auth.test` was called with `Authorization: Bearer xoxb-mock`.
6. Register a fake worker agent: `POST /api/agents { name, isLead:false }` with a fixed UUID
   `X-Agent-ID` (agent-swarm requires valid-UUID agent IDs — §6).
7. Inject an inbound Slack message via the mock's WS (e.g. `<@BOT_ID> say hello`), targeting the
   seeded channel.
8. Wait (poll, not sleep) for the mock to record an `reactions.add(name:"eyes")` call and a
   `chat.postMessage`/`say()` reply on that channel/thread — confirms Tier 1.
9. Read back the created task via `GET /api/tasks?source=slack&createdAfter=<iso-timestamp-of-step-7>`
   (`listTasks`'s query schema — `src/http/tasks.ts:172-197` — has no `slackChannelId` filter, only
   `source` (comma-separated) and `createdAfter`/`createdBefore`/`search`/`agentId`) to get the new
   task's `id`.
10. `GET /api/poll` as the fake worker agent to flip the task to `in_progress`.
11. `POST /api/tasks/{id}/finish { status: "completed", output: "..." }` as the same agent.
12. Wait (poll, up to ~5-6s to clear the watcher's 3000ms tick, `src/slack/watcher.ts:507`) for a
    follow-up `chat.postMessage`/`chat.update` recorded by the mock with the completion Block Kit
    payload — confirms Tier 2.
13. Cleanup: `proc.kill("SIGTERM")`, `await proc.exited`, remove `DATABASE_PATH` +
    `-wal`/`-shm`, remove the scratch dir, stop the mock server.

## Manual E2E (for whoever implements this)

```bash
# From the slack-mock repo, once the mock's own dev server exists:
bun run <mock-start-script>   # note the printed Web API + WS URLs

# In a second terminal, from agent-swarm's repo root, boot against the mock manually
# (requires the §0 SLACK_API_URL patch to be applied to a local branch first):
DATABASE_PATH=/tmp/slack-mock-manual.sqlite \
PORT=13099 \
API_KEY=manual-e2e-key AGENT_SWARM_API_KEY=manual-e2e-key \
SLACK_BOT_TOKEN=xoxb-mock SLACK_APP_TOKEN=xapp-mock \
SLACK_API_URL=http://127.0.0.1:<mockPort>/api/ \
GITHUB_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true \
NODE_ENV=test \
bun src/http.ts

# Verify boot:
curl -s http://localhost:13099/health

# Drive a fake completion by hand (fake worker agent):
AGENT=$(uuidgen)
curl -s -X POST http://localhost:13099/api/agents -H "Authorization: Bearer manual-e2e-key" \
  -H "X-Agent-ID: $AGENT" -H "Content-Type: application/json" \
  -d '{"name":"manual-e2e-worker","isLead":false}'
curl -s http://localhost:13099/api/poll -H "Authorization: Bearer manual-e2e-key" -H "X-Agent-ID: $AGENT"
# <taskId> from the poll response, if a Slack-originated task was already pending for this agent:
curl -s -X POST http://localhost:13099/api/tasks/<taskId>/finish \
  -H "Authorization: Bearer manual-e2e-key" -H "X-Agent-ID: $AGENT" -H "Content-Type: application/json" \
  -d '{"status":"completed","output":"manual e2e output"}'

# Cleanup:
kill $(lsof -ti :13099)
rm -f /tmp/slack-mock-manual.sqlite*
```
