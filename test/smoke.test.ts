import { afterAll, beforeAll, expect, test } from "bun:test";
import { App, LogLevel } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
let app: App;
const seen: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
  app = new App({
    token: mock.env.SLACK_BOT_TOKEN,
    appToken: mock.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.ERROR,
    clientOptions: { slackApiUrl: mock.env.SLACK_API_URL },
  });
  app.event("app_mention", async ({ event, say }) => {
    seen.push(event as unknown as Record<string, unknown>);
    await say({ text: `hi <@${event.user}>`, thread_ts: event.ts });
  });
  app.event("message", async ({ event }) => {
    seen.push(event as unknown as Record<string, unknown>);
  });
  await app.start();
  await mock.waitForConnection();
});

afterAll(async () => {
  await app.stop();
  await mock.stop();
});

test("mention -> app_mention + message events -> threaded reply stored", async () => {
  const bot = mock.bot.userId;
  const msg = await mock.postMessage({
    channel: "general",
    user: "alice",
    text: `<@${bot}> hello there`,
  });
  const reply = await mock.waitForMessage({ channel: "general", thread_ts: msg.ts, from: "bot" });
  expect(reply.text).toBe("hi <@U0ALICE000>");
  expect(reply.bot_id).toBe(mock.bot.botId);
  await mock.flush();
  // Bolt's ignoreSelf middleware drops the echo of the bot's own reply, like it does with real Slack.
  expect(seen.map((e) => e.type)).toEqual(["app_mention", "message"]);
  const delivered = mock.deliveries();
  expect(delivered.map((d) => `${d.name}:${d.acked}`)).toEqual([
    "app_mention:true",
    "message:true",
    "message:true",
  ]);
  const thread = mock.thread("general", msg.ts);
  expect(thread.map((m) => m.text)).toEqual([`<@${bot}> hello there`, "hi <@U0ALICE000>"]);
  expect(thread[0]!.reply_count).toBe(1);
});
