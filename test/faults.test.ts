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

test("WebClient retries a ratelimited request", async () => {
  mock.injectFault({
    method: "chat.postMessage",
    error: "ratelimited",
    httpStatus: 429,
    retryAfterSec: 1,
  });
  const started = Date.now();
  await client.chat.postMessage({ channel: "C0GENERAL0", text: "retry" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  const calls = mock.apiCalls("chat.postMessage");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.ok).toBeFalse();
});

test("fault extras remain available on WebClient errors", async () => {
  mock.injectFault({
    method: "conversations.join",
    error: "missing_scope",
    extra: { needed: "channels:join" },
  });
  const error = await rejected(client.conversations.join({ channel: "C0GENERAL0" }));
  expect(errorCode(error)).toBe("missing_scope");
  expect((error as { data: { needed: string } }).data.needed).toBe("channels:join");
});
