// Hosted demo entrypoint (Dockerfile CMD). One image, two deployments:
//   - demo.slack-mock.dev: the library's own demo, mock + demo bot, defaults below.
//   - swarm-demo.slack-mock.dev: a workspace for an external bot (Agent Swarm). DEMO_BOT=off,
//     custom tokens, a seed file and the prompt driver.
// Env: PORT, HOST, DATA_FILE, PUBLIC_URL, ADMIN_AUTH ("user:pass"), UI_PUBLIC ("true" keeps the
// HTML UI readable while ADMIN_AUTH gates /mock/*), RESET_EVERY_HOURS, MANIFEST, APP_NAME,
// DEMO_BOT ("off" skips the built-in bot), SLACK_MOCK_BOT_TOKEN / SLACK_MOCK_APP_TOKEN (the
// tokens the app must present; defaults are public knowledge, so set them on any shared host),
// SEED_FILE (JSON, see scripts/seed.ts) and DRIVER_INTERVAL_MINUTES (0 = off).
import { existsSync, rmSync } from "node:fs";
import { SlackMock } from "../src/index.ts";
import { startDemoBot } from "./demo-bot.ts";
import { startDriver } from "./driver.ts";
import { applySeed, loadSeedFile } from "./seed.ts";

const flag = (value: string | undefined, fallback: boolean): boolean => {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "on" || v === "yes";
};

const port = Number(process.env.PORT ?? 8080);
const dataFile = process.env.DATA_FILE || undefined;
const seedFile = process.env.SEED_FILE || undefined;
const demoBot = flag(process.env.DEMO_BOT, true);
const seed = seedFile ? loadSeedFile(seedFile) : undefined;

const mock = await SlackMock.start({
  port,
  host: process.env.HOST ?? "127.0.0.1",
  dataFile,
  publicUrl: process.env.PUBLIC_URL || undefined,
  adminAuth: process.env.ADMIN_AUTH || undefined,
  publicUi: flag(process.env.UI_PUBLIC, false),
  presenterAuth: process.env.PRESENTER_AUTH || undefined,
  manifest: process.env.MANIFEST || undefined,
  appName: process.env.APP_NAME || "demo-bot",
  botToken: process.env.SLACK_MOCK_BOT_TOKEN || undefined,
  appToken: process.env.SLACK_MOCK_APP_TOKEN || undefined,
  // A seed file replaces the built-in #general/alice/bob workspace.
  seed: seed === undefined,
  log: true,
});

if (seed) {
  if (mock.store.channels.size === 0) {
    const created = applySeed(mock, seed);
    console.log(
      `[demo] seeded ${created.users} users, ${created.channels} channels, ${created.messages} messages from ${seedFile}`,
    );
  } else {
    console.log("[demo] journal already has channels; seed file not applied");
  }
} else if (mock.messages("general").length === 0) {
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
  void welcome;
}

if (demoBot) {
  await startDemoBot(mock);
  await mock.waitForConnection(15_000).catch(() => {});
  if (!seed && mock.messages("general").length <= 1) {
    await mock
      .postMessage({
        channel: "general",
        user: "alice",
        text: `<@${mock.bot.userId}> show me what you can do`,
      })
      .catch(() => {});
  }
} else {
  console.log("[demo] built-in demo bot is off; waiting for an external app over Socket Mode");
}

const driverMinutes = Number(process.env.DRIVER_INTERVAL_MINUTES ?? 0);
if (driverMinutes > 0 && seed?.driver?.prompts?.length) {
  startDriver(mock, { intervalMinutes: driverMinutes, prompts: seed.driver.prompts });
}

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
