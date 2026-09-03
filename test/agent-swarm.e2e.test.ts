// End-to-end: the real agent-swarm API server (Bolt, Socket Mode) talking to slack-mock.
// Needs an agent-swarm checkout (AGENT_SWARM_REPO, default ../agent-swarm) with the
// SLACK_API_URL patch in src/slack/app.ts. Opt in with SLACK_MOCK_E2E=1 (bun run test:e2e). No LLM, no Docker:
// a fake lead agent claims the task over HTTP and finishes it, then the Slack watcher
// posts the outcome back into the mock.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findChrome, SlackMock, screenshot } from "../src/index.ts";

const REPO = process.env.AGENT_SWARM_REPO ?? resolve(import.meta.dir, "../../agent-swarm");
const ENABLED = process.env.SLACK_MOCK_E2E === "1" && existsSync(join(REPO, "src/http.ts"));
const API_KEY = "slack-mock-e2e-key";
const LEAD_ID = "11111111-1111-4111-8111-111111111111";

setDefaultTimeout(90_000);

async function getFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

describe.skipIf(!ENABLED)("agent-swarm against slack-mock", () => {
  let mock: SlackMock;
  let proc: ReturnType<typeof Bun.spawn>;
  let base: string;
  let dir: string;
  let logPath: string;

  const api = async (method: string, path: string, body?: unknown, agentId = LEAD_ID) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "X-Agent-ID": agentId,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json as Record<string, unknown> & unknown[] };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "slack-mock-e2e-"));
    logPath = join(dir, "agent-swarm.log");
    mock = await SlackMock.start({
      port: 0,
      manifest: join(REPO, "slack-manifest.json"),
      dataFile: join(dir, "slack.jsonl"),
    });
    const port = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    const logFd = openSync(logPath, "a");
    proc = Bun.spawn(["bun", "src/http.ts"], {
      cwd: REPO,
      stdout: logFd,
      stderr: logFd,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: join(dir, "db.sqlite"),
        AGENT_FS_LOCAL_DIR: join(dir, "fs"),
        API_KEY,
        AGENT_SWARM_API_KEY: API_KEY,
        NODE_ENV: "test",
        SLACK_DISABLE: "",
        SLACK_BOT_TOKEN: mock.env.SLACK_BOT_TOKEN,
        SLACK_APP_TOKEN: mock.env.SLACK_APP_TOKEN,
        SLACK_API_URL: mock.env.SLACK_API_URL,
        GITHUB_DISABLE: "true",
        JIRA_DISABLE: "true",
        LINEAR_DISABLE: "true",
        OAUTH_KEEPALIVE_DISABLE: "true",
      },
    });
    await waitFor(
      async () => {
        if (proc.exitCode !== null)
          throw new Error(`agent-swarm exited early with ${proc.exitCode}; see ${logPath}`);
        try {
          const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
          return res.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      "agent-swarm /health",
      85_000,
    );
    await mock.waitForConnection(60_000);
  });

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await proc?.exited;
    await mock?.stop();
    if (process.env.SLACK_MOCK_E2E_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
    else console.log(`kept e2e artifacts in ${dir}`);
  });

  test("boots Bolt against the mock: auth.test + Socket Mode connection", () => {
    expect(mock.apiCalls("auth.test").length).toBeGreaterThan(0);
    expect(mock.apiCalls("apps.connections.open").length).toBeGreaterThan(0);
    expect(mock.hub.connectionCount).toBe(1);
  });

  test("channel @mention creates a task, gets an eyes reaction and a threaded reply", async () => {
    const lead = await api("POST", "/api/agents", { name: "e2e-lead", isLead: true });
    expect(lead.status).toBeLessThan(300);

    const ask = await mock.postMessage({
      channel: "general",
      user: "alice",
      text: `<@${mock.bot.userId}> say hello from the e2e test`,
    });

    const reaction = await mock.waitForApiCall("reactions.add", {
      timeoutMs: 30_000,
      where: (c) => c.args.name === "eyes" && c.args.timestamp === ask.ts,
    });
    expect(reaction.ok).toBe(true);
    const reply = await mock.waitForMessage(
      { channel: "general", thread_ts: ask.ts, from: "bot" },
      { timeoutMs: 30_000 },
    );
    expect(reply.thread_ts).toBe(ask.ts);

    // Find the task agent-swarm created for this thread.
    const task = await waitFor(
      async () => {
        const res = await api("GET", "/api/tasks?source=slack&fields=full&limit=50");
        const list = (
          Array.isArray(res.body) ? res.body : ((res.body as { tasks?: unknown[] }).tasks ?? [])
        ) as Array<Record<string, unknown>>;
        return list.find((t) => t.slackThreadTs === ask.ts || t.slackTriggerMessageTs === ask.ts);
      },
      "the slack task",
      30_000,
    );
    expect(task.status).toBe("pending");

    // The fake lead claims the task (poll flips it to in_progress) and finishes it.
    // One poll claims the pending task; polling again while it runs would look like a crash to agent-swarm.
    const poll = await api("GET", "/api/poll");
    expect(poll.status).toBe(200);
    await waitFor(
      async () => {
        const res = await api("GET", `/api/tasks/${task.id}`);
        return res.body.status === "in_progress" ? true : undefined;
      },
      "task to be in_progress after poll",
      15_000,
    );
    const finish = await api("POST", `/api/tasks/${task.id}/finish`, {
      status: "completed",
      output: "hello from the e2e worker",
    });
    expect(finish.status).toBeLessThan(300);

    // The watcher (3s tick) posts the outcome into the thread and flips the reaction.
    const outcome = await mock.waitForMessage(
      (m) =>
        m.channel === "C0GENERAL0" &&
        m.thread_ts === ask.ts &&
        JSON.stringify(m).includes("hello from the e2e worker"),
      { timeoutMs: 30_000 },
    );
    expect(outcome.bot_id).toBe(mock.bot.botId);
    await waitFor(
      () =>
        mock
          .messages("general")
          .find((m) => m.ts === ask.ts)
          ?.reactions?.some((r) => r.name === "white_check_mark")
          ? true
          : undefined,
      "white_check_mark reaction",
      30_000,
    );

    if (findChrome()) {
      const out = join(import.meta.dir, "artifacts", "agent-swarm-thread.png");
      await screenshot(`${mock.baseUrl}/c/C0GENERAL0/t/${ask.ts}`, { out });
      expect(existsSync(out)).toBe(true);
    }
  });

  test("/agent-swarm-status replies ephemerally", async () => {
    const r = await mock.slashCommand({
      command: "/agent-swarm-status",
      user: "alice",
      channel: "general",
    });
    expect(r.ack.attempts).toBeGreaterThan(0);
    const eph = await waitFor(
      () =>
        mock
          .ephemeralMessages("general")
          .find((m) => JSON.stringify(m.blocks ?? m.text).includes("Agent Swarm Status")),
      "ephemeral status response",
      15_000,
    );
    expect(eph.ephemeral_user).toBe("U0ALICE000");
  });
});
