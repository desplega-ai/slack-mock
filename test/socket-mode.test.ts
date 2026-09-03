import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
import { appFor } from "./helpers.ts";

async function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket frame")),
      2_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

async function rawSocket(mock: SlackMock): Promise<WebSocket> {
  const response = await fetch(`${mock.env.SLACK_API_URL}apps.connections.open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${mock.env.SLACK_APP_TOKEN}` },
    body: new URLSearchParams(),
  });
  const { url } = (await response.json()) as { url: string };
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), {
      once: true,
    });
  });
  return socket;
}

test("raw Socket Mode hello and ack timeout redelivery match Slack", async () => {
  const mock = await SlackMock.start({ port: 0, ackTimeoutMs: 200, maxRetries: 1 });
  const socket = await rawSocket(mock);
  const hello = await nextFrame(socket);
  expect(hello.type).toBe("hello");
  expect((hello.connection_info as { app_id: string }).app_id).toBe(mock.team.id.replace("T", "A"));

  const delivery = mock.postMessage({ channel: "general", user: "alice", text: "retry me" });
  const first = await nextFrame(socket);
  const second = await nextFrame(socket);
  expect(second.envelope_id).toBe(first.envelope_id);
  expect(second.retry_attempt).toBe(1);
  expect(second.retry_reason).toBe("timeout");
  socket.send(JSON.stringify({ envelope_id: first.envelope_id, payload: {} }));
  await delivery;
  expect(mock.deliveries().at(-1)).toMatchObject({ attempts: 2, acked: true });
  socket.close();
  await mock.stop();
});

describe("connected and disconnected apps", () => {
  let mock: SlackMock;
  let app: App;
  const seen: string[] = [];

  beforeAll(async () => {
    mock = await SlackMock.start({ port: 0 });
    app = appFor(mock);
    app.event("message", async ({ event }) => {
      seen.push((event as unknown as { text: string }).text);
    });
    await app.start();
    await mock.waitForConnection();
  });

  afterAll(async () => {
    await app.stop();
    await mock.stop();
  });

  test("disconnect reconnects after Bolt's five-second backoff", async () => {
    mock.disconnectSockets("refresh_requested");
    const deadline = Date.now() + 8_000;
    while (mock.hub.connectionCount !== 0 && Date.now() < deadline) await Bun.sleep(25);
    while (mock.hub.connectionCount !== 1 && Date.now() < deadline) await Bun.sleep(25);
    expect(mock.hub.connectionCount).toBe(1);
    await mock.postMessage({ channel: "general", user: "alice", text: "after reconnect" });
    await mock.flush();
    expect(seen).toContain("after reconnect");
  }, 15_000);
});

test("events drop without a connection and connection waits time out", async () => {
  const mock = await SlackMock.start({ port: 0 });
  await mock.postMessage({ channel: "general", user: "alice", text: "nobody home" });
  expect(mock.deliveries()).toEqual([]);
  await expect(mock.waitForConnection(30)).rejects.toThrow("no Socket Mode connection");
  await mock.stop();
});

test("redelivery gives up after maxRetries and records the failure", async () => {
  const mock = await SlackMock.start({ port: 0, ackTimeoutMs: 100, maxRetries: 1 });
  try {
    const open = await fetch(`${mock.apiUrl}apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${mock.env.SLACK_APP_TOKEN}` },
    });
    const { url } = (await open.json()) as { url: string };
    const ws = new WebSocket(url);
    const frames: string[] = [];
    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        frames.push(String(e.data));
        if (frames.length === 1) resolve();
      };
    });
    await mock.postMessage({ channel: "general", user: "alice", text: "never acked" });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && frames.length < 3) await Bun.sleep(20);
    expect(frames.length).toBe(3);
    const last = mock.deliveries().at(-1);
    expect(last).toMatchObject({ acked: false, attempts: 2 });
    expect(mock.hub.connectionCount).toBe(1);
    ws.close();
  } finally {
    await mock.stop();
  }
});
