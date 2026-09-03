import { afterAll, beforeAll, expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
let client: WebClient;

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
  client = new WebClient(mock.env.SLACK_BOT_TOKEN, { slackApiUrl: mock.env.SLACK_API_URL });
});

afterAll(async () => {
  await mock.stop();
});

test("a streamed reply keeps its Markdown body and appends the stopStream blocks", async () => {
  const parent = await mock.postMessage({
    channel: "general",
    user: "alice",
    text: "<@U0BOT00000> how you doing?",
  });
  const started = await client.chat.startStream({
    channel: "C0GENERAL0",
    thread_ts: parent.ts,
    markdown_text: "✅\n\nDoing **great**, see [the task](https://example.test/tasks/1).",
  });
  await client.chat.appendStream({
    channel: "C0GENERAL0",
    ts: started.ts!,
    markdown_text: " Bye.",
  });
  await client.chat.stopStream({
    channel: "C0GENERAL0",
    ts: started.ts!,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "9s · Lead · `a5cd1d56`" }] }],
  });

  const html = await (await fetch(`${mock.baseUrl}/c/general/t/${parent.ts}?full`)).text();
  const bodyAt = html.indexOf("Doing ");
  const contextAt = html.indexOf("9s · Lead");
  expect(bodyAt).toBeGreaterThan(-1);
  expect(contextAt).toBeGreaterThan(bodyAt);
  expect(html).toContain("Bye.");
  expect(html).toContain('href="https://example.test/tasks/1"');
  expect(html).not.toContain("(edited)");
  const stored = mock.messages("general").find((m) => m.ts === started.ts)!;
  expect(stored.edited).toBeUndefined();
});

test("a plain message with blocks still renders the blocks only", async () => {
  await client.chat.postMessage({
    channel: "C0GENERAL0",
    text: "fallback text",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "block body" } }],
  });
  const html = await (await fetch(`${mock.baseUrl}/c/general`)).text();
  expect(html).toContain("block body");
  expect(html).not.toContain("fallback text");
});
