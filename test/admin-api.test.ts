import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
});
afterAll(async () => {
  await mock.stop();
});

const post = (path: string, body: unknown) =>
  fetch(`${mock.baseUrl}/mock/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("/mock/messages posts as a human and translates @name mentions", async () => {
  const res = await post("messages", {
    channel: "general",
    user: "alice",
    text: "hey @bob and @mock-bot, @here! me@x.com @nobody",
  });
  expect(res.status).toBe(200);
  const m = (await res.json()) as { text: string; user: string; channel: string };
  expect(m.text).toBe(`hey <@U0BOB00000> and <@${mock.bot.userId}>, <!here>! me@x.com @nobody`);
  expect(m.user).toBe("U0ALICE000");
  const list = (await (await fetch(`${mock.baseUrl}/mock/channels/general`)).json()) as Array<{
    text: string;
  }>;
  expect(list.at(-1)?.text).toBe(m.text);
});

test("/mock/messages threads a reply and /mock/channels/:id/threads/:ts returns it", async () => {
  const parent = (await (
    await post("messages", { channel: "general", user: "bob", text: "parent" })
  ).json()) as { ts: string };
  await post("messages", {
    channel: "general",
    user: "alice",
    text: "reply",
    thread_ts: parent.ts,
  });
  const thread = (await (
    await fetch(`${mock.baseUrl}/mock/channels/C0GENERAL0/threads/${parent.ts}`)
  ).json()) as Array<{ text: string }>;
  expect(thread.map((m) => m.text)).toEqual(["parent", "reply"]);
});

test("/mock/reactions supports selected users and removal", async () => {
  const message = (await (
    await post("messages", { channel: "general", user: "alice", text: "react to me" })
  ).json()) as { ts: string };
  const reaction = (body: unknown) => post("reactions", body);
  const base = { channel: "general", ts: message.ts, name: "eyes" };

  expect((await reaction(base)).status).toBe(200);
  expect((await reaction({ ...base, user: "bob" })).status).toBe(200);
  expect((await reaction({ ...base, name: "wave", user: "U0ALICE000" })).status).toBe(200);

  const stored = mock.store.message("C0GENERAL0", message.ts);
  expect(stored.reactions).toEqual([
    { name: "eyes", users: ["U0ALICE000", "U0BOB00000"], count: 2 },
    { name: "wave", users: ["U0ALICE000"], count: 1 },
  ]);

  expect((await reaction({ ...base, action: "remove", user: "U0ALICE000" })).status).toBe(200);
  expect(mock.store.message("C0GENERAL0", message.ts).reactions).toEqual([
    { name: "eyes", users: ["U0BOB00000"], count: 1 },
    { name: "wave", users: ["U0ALICE000"], count: 1 },
  ]);

  const duplicate = await reaction({ ...base, name: "wave", user: "U0ALICE000" });
  expect(duplicate.status).toBe(400);
  expect(await duplicate.json()).toEqual({ ok: false, error: "already_reacted" });
  const absent = await reaction({ ...base, action: "remove", user: "alice" });
  expect(absent.status).toBe(400);
  expect(await absent.json()).toEqual({ ok: false, error: "no_reaction" });
  const invalid = await reaction({ ...base, action: "toggle" });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ ok: false, error: "invalid_arguments" });
});

test("text that looks like JSON stays an opaque string on the Web API", async () => {
  const res = await fetch(`${mock.apiUrl}chat.postMessage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ channel: "C0GENERAL0", text: '{"status":"ok","count":3}' }),
  });
  const body = (await res.json()) as { ok: boolean; message: { text: string } };
  expect(body.ok).toBe(true);
  expect(body.message.text).toBe('{"status":"ok","count":3}');
  const empty = await fetch(`${mock.apiUrl}chat.postMessage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ channel: "C0GENERAL0", text: "[]" }),
  });
  expect(((await empty.json()) as { ok: boolean }).ok).toBe(true);
});

test("unknown admin route is a 404 JSON error", async () => {
  const res = await fetch(`${mock.baseUrl}/mock/nope`);
  expect(res.status).toBe(404);
});
