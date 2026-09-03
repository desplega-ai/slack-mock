import { afterAll, beforeAll, expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import { SlackMock } from "../src/index.ts";
import { errorCode, rejected } from "./helpers.ts";

let mock: SlackMock;
let client: WebClient;

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
  client = new WebClient(mock.env.SLACK_BOT_TOKEN, { slackApiUrl: mock.env.SLACK_API_URL });
});

afterAll(async () => {
  await mock.stop();
});

test("streaming messages complete, reject double stops, and can be updated", async () => {
  const parent = await mock.postMessage({ channel: "general", user: "alice", text: "parent" });
  const started = await client.chat.startStream({
    channel: "C0GENERAL0",
    thread_ts: parent.ts,
    markdown_text: "Hello ",
  });
  await client.chat.appendStream({
    channel: "C0GENERAL0",
    ts: started.ts!,
    markdown_text: "world",
  });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "done" } }];
  await client.chat.stopStream({ channel: "C0GENERAL0", ts: started.ts!, blocks });
  const completed = mock.messages("general").find((message) => message.ts === started.ts)!;
  expect(completed.text).toBe("Hello world");
  expect(completed.streaming_state).toBe("completed");
  expect(completed.blocks).toEqual(blocks);
  expect(
    errorCode(await rejected(client.chat.stopStream({ channel: "C0GENERAL0", ts: started.ts! }))),
  ).toBe("message_not_in_streaming_state");
  await client.chat.update({ channel: "C0GENERAL0", ts: started.ts!, text: "updated stream" });
  expect(mock.messages("general").find((message) => message.ts === started.ts)?.text).toBe(
    "updated stream",
  );
});
