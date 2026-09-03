// Hosted demo entrypoint (Docker / Fly): the mock plus the demo bot in one process.
// Env: PORT, HOST, DATA_FILE, PUBLIC_URL, ADMIN_AUTH ("user:pass"), RESET_EVERY_HOURS, MANIFEST.
import { existsSync, rmSync } from "node:fs";
import { SlackMock } from "../src/index.ts";
import { startDemoBot } from "./demo-bot.ts";

const port = Number(process.env.PORT ?? 8080);
const dataFile = process.env.DATA_FILE || undefined;
const mock = await SlackMock.start({
  port,
  host: process.env.HOST ?? "127.0.0.1",
  dataFile,
  publicUrl: process.env.PUBLIC_URL || undefined,
  adminAuth: process.env.ADMIN_AUTH || undefined,
  manifest: process.env.MANIFEST || undefined,
  appName: "demo-bot",
  log: true,
});

if (mock.messages("general").length === 0) {
  const bot = mock.bot.userId;
  const welcome = mock.store.addMessage({
    channel: "C0GENERAL0",
    user: bot,
    bot_id: mock.bot.botId,
    app_id: mock.store.app.id,
    text: "Welcome to the slack-mock demo",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Welcome to slack-mock", emoji: true } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "This is a *mock Slack server*: a real Bolt app (the demo bot) is connected over Socket Mode. Everything you see is stored by the mock and rendered here.\n\nTry it:\n• type `@demo-bot review PR 42` below and watch the thread\n• click *Cancel* on a card while it is working\n• open the DM with the bot from the sidebar",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "<https://github.com/desplega-ai/slack-mock|GitHub> · <https://www.npmjs.com/package/@desplega.ai/slack-mock|npm> · the workspace resets every day",
          },
        ],
      },
    ],
  });
  await mock
    .postMessage({ channel: "general", user: "alice", text: `<@${bot}> show me what you can do` })
    .catch(() => {});
  void welcome;
}

await startDemoBot(mock);
console.log(`demo ready at ${mock.baseUrl} (local ${mock.localUrl})`);

const resetHours = Number(process.env.RESET_EVERY_HOURS ?? 0);
if (resetHours > 0) {
  setTimeout(() => {
    console.log("[demo] scheduled reset: wiping the journal and exiting for a restart");
    if (dataFile && existsSync(dataFile)) rmSync(dataFile);
    process.exit(0);
  }, resetHours * 3600_000).unref?.();
}

const stop = async () => {
  await mock.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
