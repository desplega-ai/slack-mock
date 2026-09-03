import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({
    port: 0,
    adminAuth: "ops:secret",
    presenterAuth: "stage:pass",
    publicUi: true,
  });
});
afterAll(async () => {
  await mock.stop();
});

const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;
const admin = basic("ops:secret");
const presenter = basic("stage:pass");

test("presenterAuth may post messages and read its role, nothing else", async () => {
  const post = await fetch(`${mock.baseUrl}/mock/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: presenter },
    body: JSON.stringify({ channel: "general", user: "alice", text: "hello from the stage" }),
  });
  expect(post.status).toBe(200);
  expect(mock.findMessages({ channel: "general", text: /from the stage/ })).toHaveLength(1);

  const role = await fetch(`${mock.baseUrl}/mock/presenter`, {
    headers: { authorization: presenter },
  });
  expect(await role.json()).toEqual({ ok: true, role: "presenter" });
  const adminRole = await fetch(`${mock.baseUrl}/mock/presenter`, {
    headers: { authorization: admin },
  });
  expect(await adminRole.json()).toEqual({ ok: true, role: "admin" });

  const state = await fetch(`${mock.baseUrl}/mock/state`, {
    headers: { authorization: presenter },
  });
  expect(state.status).toBe(403);
  const reset = await fetch(`${mock.baseUrl}/mock/reactions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: presenter },
    body: JSON.stringify({ channel: "general", ts: "1", name: "eyes" }),
  });
  expect(reset.status).toBe(403);
});

test("a wrong Authorization header on /mock is a plain 403; no header keeps the 401 challenge", async () => {
  const wrong = await fetch(`${mock.baseUrl}/mock/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic("stage:nope") },
    body: JSON.stringify({ channel: "general", user: "alice", text: "x" }),
  });
  expect(wrong.status).toBe(403);
  expect(wrong.headers.get("www-authenticate")).toBeNull();

  const none = await fetch(`${mock.baseUrl}/mock/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "general", user: "alice", text: "x" }),
  });
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toContain("Basic");
  expect(mock.findMessages({ channel: "general", text: "x" })).toHaveLength(0);
});

test("public-read pages render a gated composer with the sign-in form", async () => {
  const html = await (await fetch(`${mock.baseUrl}/c/general`)).text();
  expect(html).toContain('data-gated="1"');
  expect(html).toContain("GATED=true");
  expect(html).toContain('class="sm-composer-lock"');
});

test("without adminAuth the composer is open and the presenter route reports admin", async () => {
  const open = await SlackMock.start({ port: 0, publicUi: true, presenterAuth: "stage:pass" });
  try {
    const html = await (await fetch(`${open.baseUrl}/c/general`)).text();
    expect(html).toContain("GATED=false");
    expect(html).not.toContain('class="sm-composer-lock"');
    expect(await (await fetch(`${open.baseUrl}/mock/presenter`)).json()).toEqual({
      ok: true,
      role: "admin",
    });
  } finally {
    await open.stop();
  }
});

test("gated UI without publicUi keeps the browser-auth flow and no sign-in form", async () => {
  const gated = await SlackMock.start({ port: 0, adminAuth: "ops:secret" });
  try {
    const html = await (
      await fetch(`${gated.baseUrl}/c/general`, { headers: { authorization: admin } })
    ).text();
    expect(html).toContain("GATED=false");
  } finally {
    await gated.stop();
  }
});
