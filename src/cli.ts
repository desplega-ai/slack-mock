#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { frames } from "./frames.ts";
import { screenshot } from "./screenshot.ts";
import { SlackMock } from "./server.ts";

const USAGE = `slack-mock: a mock Slack server (Web API + Socket Mode) for testing bots

Usage:
  slack-mock serve [--port 4040] [--host 127.0.0.1] [--data ./data/slack.jsonl] [--manifest app.json]
                   [--no-seed] [--quiet] [--panel 50] [--auth user:pass] [--public-url https://mock.example.com]
  slack-mock screenshot <url> --out shot.png [--width 800] [--height 1000]
  slack-mock frames --journal data.jsonl --channel C0GENERAL0 [--thread 1788516626.286000] --out ./frames
                    [--manifest app.json] [--width 800] [--height 700] [--no-desktop]

frames renders the thread (or, without --thread, the channel) as it looked after every journal
line that touched it: one PNG per line, then final-thread.png and final-desktop.png.

serve prints the env vars to give your bot (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_API_URL)
and the URLs of the HTML views. Inject messages with the admin API, e.g.
  curl -X POST http://127.0.0.1:4040/mock/messages -H 'content-type: application/json' \\
       -d '{"channel":"general","user":"alice","text":"<@U0BOT00000> hello"}'
`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "serve") {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: "string", default: "4040" },
        host: { type: "string", default: "127.0.0.1" },
        data: { type: "string" },
        manifest: { type: "string" },
        "no-seed": { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        panel: { type: "string" },
        auth: { type: "string" },
        "public-url": { type: "string" },
      },
    });
    const mock = await SlackMock.start({
      panelWidth: values.panel,
      adminAuth: values.auth,
      publicUrl: values["public-url"],
      port: Number(values.port),
      host: values.host,
      dataFile: values.data,
      manifest: values.manifest,
      seed: !values["no-seed"],
      log: !values.quiet,
    });
    console.log(`slack-mock listening on ${mock.baseUrl}`);
    console.log("");
    console.log("Bot environment:");
    for (const [k, v] of Object.entries(mock.env)) console.log(`  ${k}=${v}`);
    console.log("");
    console.log(
      `Workspace: ${mock.baseUrl}/   (bot user ${mock.bot.userId}, team ${mock.team.id})`,
    );
    for (const c of mock.store.channels.values())
      console.log(`  #${c.name}: ${mock.baseUrl}/c/${c.id}`);
    console.log("");
    console.log(`Admin API: POST ${mock.baseUrl}/mock/messages {channel,user,text,thread_ts}`);
    const stop = async () => {
      await mock.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (command === "screenshot") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string", default: "slack-mock.png" },
        width: { type: "string", default: "800" },
        height: { type: "string", default: "1000" },
      },
    });
    const url = positionals[0];
    if (!url) throw new Error("screenshot needs a URL");
    const out = await screenshot(url, {
      out: values.out,
      width: Number(values.width),
      height: Number(values.height),
    });
    console.log(out);
    return;
  }
  if (command === "frames") {
    const { values } = parseArgs({
      args: rest,
      options: {
        journal: { type: "string" },
        channel: { type: "string" },
        thread: { type: "string" },
        out: { type: "string" },
        manifest: { type: "string" },
        width: { type: "string", default: "800" },
        height: { type: "string", default: "700" },
        "no-desktop": { type: "boolean", default: false },
      },
    });
    if (!values.journal || !values.channel || !values.out)
      throw new Error("frames needs --journal, --channel and --out");
    const result = await frames({
      journal: values.journal,
      channel: values.channel,
      thread: values.thread,
      out: values.out,
      manifest: values.manifest,
      width: Number(values.width),
      height: Number(values.height),
      desktop: !values["no-desktop"],
    });
    for (const f of result.frames) console.log(`${f.index}\t${f.kind}\t${f.path}`);
    console.log(`final-thread=${result.finalThread}`);
    if (result.finalDesktop) console.log(`final-desktop=${result.finalDesktop}`);
    return;
  }
  console.log(USAGE);
  if (command && command !== "help" && command !== "--help") process.exit(1);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
