import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({ port: 0, adminAuth: "demo:secret" });
});
afterAll(async () => {
  await mock.stop();
});

const basic = (v: string) => ({ authorization: `Basic ${Buffer.from(v).toString("base64")}` });

test("basic auth guards the UI and /mock but not the Slack API", async () => {
  expect((await fetch(`${mock.localUrl}/`)).status).toBe(401);
  expect((await fetch(`${mock.localUrl}/c/general`)).status).toBe(401);
  expect((await fetch(`${mock.localUrl}/mock/state`)).status).toBe(401);
  expect((await fetch(`${mock.localUrl}/`, { headers: basic("demo:wrong") })).status).toBe(401);
  expect(
    (await fetch(`${mock.localUrl}/mock/state`, { headers: basic("demo:secret") })).status,
  ).toBe(200);
  const api = await fetch(`${mock.apiUrl}auth.test`, {
    method: "POST",
    headers: { authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}` },
  });
  expect(((await api.json()) as { ok: boolean }).ok).toBe(true);
});

test("URLs handed out follow the request Host and X-Forwarded-Proto", async () => {
  const open = await fetch(`${mock.apiUrl}apps.connections.open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mock.env.SLACK_APP_TOKEN}`,
      host: "demo.slack-mock.dev",
      "x-forwarded-proto": "https",
    },
  });
  const { url } = (await open.json()) as { url: string };
  expect(url.startsWith("wss://demo.slack-mock.dev/link/?ticket=")).toBe(true);
  const upload = await fetch(`${mock.apiUrl}files.getUploadURLExternal`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
      host: "demo.slack-mock.dev",
      "x-forwarded-proto": "https",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "filename=a.txt&length=1",
  });
  const { upload_url } = (await upload.json()) as { upload_url: string };
  expect(upload_url.startsWith("https://demo.slack-mock.dev/upload/v1/")).toBe(true);
});

test("publicUrl wins over the request host", async () => {
  const fixed = await SlackMock.start({ port: 0, publicUrl: "https://mock.example.com/" });
  try {
    expect(fixed.baseUrl).toBe("https://mock.example.com");
    expect(fixed.env.SLACK_API_URL).toBe("https://mock.example.com/api/");
    const open = await fetch(`${fixed.localUrl}/api/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixed.env.SLACK_APP_TOKEN}`, host: "other.host" },
    });
    expect(
      ((await open.json()) as { url: string }).url.startsWith("wss://mock.example.com/link/"),
    ).toBe(true);
  } finally {
    await fixed.stop();
  }
});

test("loopback clients keep local URLs even when publicUrl is set", async () => {
  const fixed = await SlackMock.start({ port: 0, publicUrl: "https://mock.example.com" });
  try {
    const local = await fetch(`${fixed.localUrl}/api/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixed.env.SLACK_APP_TOKEN}` },
    });
    const { url } = (await local.json()) as { url: string };
    expect(url.startsWith(`${fixed.localUrl.replace("http", "ws")}/link/`)).toBe(true);
  } finally {
    await fixed.stop();
  }
});
