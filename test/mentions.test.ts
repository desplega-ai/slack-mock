import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({ port: 0, appName: "Agent Swarm" });
});
afterAll(async () => {
  await mock.stop();
});

async function post(text: string): Promise<string> {
  const res = await fetch(`${mock.baseUrl}/mock/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "general", user: "alice", text }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { text: string }).text;
}

test("@Display Name with a space resolves to the user mention", async () => {
  expect(await post("@Agent Swarm how you doing?")).toBe("<@U0BOT00000> how you doing?");
  expect(await post("hey @agent swarm, ping")).toBe("hey <@U0BOT00000>, ping");
  expect(await post("@Bob Example and @alice")).toBe("<@U0BOB00000> and <@U0ALICE000>");
});

test("special mentions, unknown names and e-mail addresses are left alone", async () => {
  expect(await post("@here and @channel")).toBe("<!here> and <!channel>");
  expect(await post("@Agent Swarmish? @nobody")).toBe("@Agent Swarmish? @nobody");
  expect(await post("mail alice@alice.example")).toBe("mail alice@alice.example");
});

test("a resolved mention renders as a highlighted pill", async () => {
  await post("@Agent Swarm pill check");
  const html = await (await fetch(`${mock.baseUrl}/c/general`)).text();
  expect(html).toContain('<span class="sm-pill">@Agent Swarm</span> pill check');
});
