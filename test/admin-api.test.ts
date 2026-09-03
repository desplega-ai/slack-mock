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
