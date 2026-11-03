import { afterEach, describe, expect, test } from "bun:test";
import { App, HTTPReceiver, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { HttpDelivery, SlackMock, slackSignature } from "../src/index.ts";

const SECRET = "test-signing-secret";

/** A real Bolt app on its HTTP receiver: Bolt itself verifies the signature on every request. */
async function httpApp() {
  const receiver = new HTTPReceiver({ signingSecret: SECRET, endpoints: "/slack/events" });
  const app = new App({
    receiver,
    // `authorize` keeps Bolt from calling auth.test: the mock does not exist yet when the app starts.
    authorize: async () => ({
      botToken: "xoxb-mock-bot-token",
      botId: "B0BOT",
      botUserId: "U0BOT00000",
    }),
    logLevel: LogLevel.ERROR,
  });
  const server = (await app.start(0)) as import("node:http").Server;
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/slack/events`;
  return { app, url, stop: () => app.stop() };
}

const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

describe("HTTP delivery", () => {
  test("signs events, slash commands and interactivity so a Bolt HTTP receiver accepts them", async () => {
    const got: string[] = [];
    const { app, url, stop } = await httpApp();
    stops.push(stop);
    app.event("app_mention", async ({ event }) => {
      got.push(`mention:${event.text}`);
    });
    app.command("/hello", async ({ ack }) => {
      await ack({ text: "hi from http" });
    });
    app.action("do_it", async ({ ack, body }) => {
      got.push(
        `action:${(body as unknown as { actions: Array<{ value: string }> }).actions[0]?.value}`,
      );
      await ack();
    });
    const mock = await SlackMock.start({
      port: 0,
      subscribedEvents: ["app_mention"],
      httpDelivery: { eventsUrl: url, signingSecret: SECRET },
      manifest: { features: { slash_commands: [{ command: "/hello", description: "d" }] } },
    });
    stops.push(() => mock.stop());

    await mock.postMessage({
      channel: "general",
      user: "alice",
      text: `<@${mock.bot.userId}> hello`,
    });
    expect(got).toContain(`mention:<@${mock.bot.userId}> hello`);

    const { ack, response } = await mock.slashCommand({ command: "/hello", channel: "general" });
    expect(ack.attempts).toBe(1);
    expect(response?.text).toBe("hi from http");

    const web = new WebClient(mock.env.SLACK_BOT_TOKEN, { slackApiUrl: mock.env.SLACK_API_URL });
    const card = await web.chat.postMessage({
      channel: mock.channel("general").id,
      text: "card",
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Go" },
              action_id: "do_it",
              value: "v1",
            },
          ],
        },
      ],
    });
    await mock.clickButton({ channel: "general", ts: card.ts as string, action_id: "do_it" });
    expect(got).toContain("action:v1");
    expect(mock.deliveries().every((d) => d.acked)).toBe(true);
  });

  test("answers a wrong signature with a refused delivery", async () => {
    const { url, stop } = await httpApp();
    stops.push(stop);
    const mock = await SlackMock.start({
      port: 0,
      subscribedEvents: ["app_mention"],
      httpDelivery: { eventsUrl: url, signingSecret: "wrong", retryDelaysMs: [] },
    });
    stops.push(() => mock.stop());
    await mock.postMessage({ channel: "general", user: "alice", text: `<@${mock.bot.userId}> hi` });
    const [delivery] = mock.deliveries("app_mention");
    expect(delivery?.acked).toBe(false);
    expect(delivery?.attempts).toBe(1);
  });

  test("redelivers an Events API request with the retry headers, then stops", async () => {
    const seen: Array<{ num: string | null; reason: string | null; signed: boolean }> = [];
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        const ts = req.headers.get("x-slack-request-timestamp") ?? "";
        seen.push({
          num: req.headers.get("x-slack-retry-num"),
          reason: req.headers.get("x-slack-retry-reason"),
          signed: req.headers.get("x-slack-signature") === slackSignature(SECRET, ts, body),
        });
        calls++;
        if (calls === 1) return new Response("boom", { status: 500 });
        if (calls === 2) await Bun.sleep(200); // past the 50ms deadline
        return new Response("");
      },
    });
    stops.push(() => server.stop(true));
    const mock = await SlackMock.start({
      port: 0,
      subscribedEvents: ["app_mention"],
      httpDelivery: {
        eventsUrl: `http://127.0.0.1:${server.port}/`,
        signingSecret: SECRET,
        retryDelaysMs: [5, 5, 5],
        timeoutMs: 50,
      },
    });
    stops.push(() => mock.stop());
    await mock.postMessage({ channel: "general", user: "alice", text: `<@${mock.bot.userId}> hi` });
    expect(seen).toEqual([
      { num: null, reason: null, signed: true },
      { num: "1", reason: "http_error", signed: true },
      { num: "2", reason: "http_timeout", signed: true },
    ]);
    const [delivery] = mock.deliveries("app_mention");
    expect(delivery).toMatchObject({ acked: true, attempts: 3 });
  });

  test("gives up after the retry budget and posts slash commands once", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits++;
        return new Response("no", { status: 500 });
      },
    });
    stops.push(() => server.stop(true));
    const delivery = new HttpDelivery({
      eventsUrl: `http://127.0.0.1:${server.port}/`,
      signingSecret: SECRET,
      retryDelaysMs: [1, 1],
    });
    await expect(delivery.send("events_api", { event: { type: "message" } })).rejects.toThrow(
      "3 attempt",
    );
    expect(hits).toBe(3);
    hits = 0;
    await expect(delivery.send("slash_commands", { command: "/x" }, true)).rejects.toThrow(
      "1 attempt",
    );
    expect(hits).toBe(1);
  });

  test("verifies the request URL with a url_verification challenge", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const { challenge } = (await req.json()) as { challenge: string };
        return Response.json({ challenge });
      },
    });
    stops.push(() => server.stop(true));
    const delivery = new HttpDelivery({
      eventsUrl: `http://127.0.0.1:${server.port}/`,
      signingSecret: SECRET,
    });
    expect(await delivery.verifyUrl()).toBe(true);
  });
});
