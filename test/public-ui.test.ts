import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({ port: 0, adminAuth: "ops:secret", publicUi: true });
});
afterAll(async () => {
  await mock.stop();
});

const basic = `Basic ${Buffer.from("ops:secret").toString("base64")}`;

test("publicUi keeps the HTML UI open while adminAuth still gates /mock/*", async () => {
  expect((await fetch(`${mock.baseUrl}/`)).status).toBe(200);
  expect((await fetch(`${mock.baseUrl}/c/general`)).status).toBe(200);

  const denied = await fetch(`${mock.baseUrl}/mock/state`);
  expect(denied.status).toBe(401);
  expect(denied.headers.get("www-authenticate")).toContain("Basic");

  const post = await fetch(`${mock.baseUrl}/mock/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "general", user: "alice", text: "hi" }),
  });
  expect(post.status).toBe(401);

  const allowed = await fetch(`${mock.baseUrl}/mock/state`, { headers: { authorization: basic } });
  expect(allowed.status).toBe(200);
});

test("without publicUi the UI is gated too (default behaviour)", async () => {
  const gated = await SlackMock.start({ port: 0, adminAuth: "ops:secret" });
  try {
    expect((await fetch(`${gated.baseUrl}/`)).status).toBe(401);
    expect((await fetch(`${gated.baseUrl}/c/general`)).status).toBe(401);
  } finally {
    await gated.stop();
  }
});
