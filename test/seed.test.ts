import { afterAll, beforeAll, expect, test } from "bun:test";
import { applySeed, loadSeedFile, withBotMention } from "../scripts/seed.ts";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({ port: 0, seed: false, appName: "Agent Swarm" });
});
afterAll(async () => {
  await mock.stop();
});

test("the shipped agent-swarm seed applies cleanly and is idempotent", () => {
  const seed = loadSeedFile("seeds/agent-swarm-demo.json");
  const first = applySeed(mock, seed);
  expect(first).toEqual({ users: 5, channels: 6, messages: 10 });

  const ask = mock.store.channelByName("ask-the-swarm");
  expect(ask).toBeDefined();
  // Every seeded channel includes the bot so it receives channel events.
  for (const channel of mock.store.channels.values()) {
    expect(channel.members).toContain(mock.bot.userId);
  }
  // Starter history never mentions the bot: nothing fires a task at boot.
  for (const [, messages] of mock.store.messages) {
    for (const m of messages) expect(m.text).not.toContain(`<@${mock.bot.userId}>`);
  }
  // The bot-authored welcome carries the bot ids like a real app post.
  const general = mock.messages("general");
  expect(general[0]?.bot_id).toBe(mock.bot.botId);
  expect(general[1]?.user).toBe("U0DANA0000");

  const again = applySeed(mock, seed);
  expect(again.users).toBe(0);
  expect(again.channels).toBe(0);
  // Messages are not deduplicated (demo-server only seeds an empty journal), so they append.
  expect(mock.messages("general").length).toBe(6);
});

test("driver prompts use the <@bot> placeholder", () => {
  const seed = loadSeedFile("seeds/agent-swarm-demo.json");
  const prompts = seed.driver?.prompts ?? [];
  expect(prompts.length).toBeGreaterThan(5);
  for (const p of prompts) {
    expect(p.text).toContain("<@bot>");
    expect(mock.store.channelByName(p.channel)).toBeDefined();
    expect(withBotMention(p.text, "U0BOT00000")).toContain("<@U0BOT00000>");
  }
});

test("connectionCount is 0 with no app attached", () => {
  expect(mock.connectionCount).toBe(0);
});
