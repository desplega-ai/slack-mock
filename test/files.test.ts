import { afterAll, beforeAll, expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
import { appFor } from "./helpers.ts";

let mock: SlackMock;
let app: App;
const fileEvents: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
  app = appFor(mock);
  app.event("message", async ({ event }) => {
    fileEvents.push(event as unknown as Record<string, unknown>);
  });
  await app.start();
  await mock.waitForConnection();
});

afterAll(async () => {
  await app.stop();
  await mock.stop();
});

test("files.uploadV2 creates a downloadable file-share thread message", async () => {
  const parent = await mock.postMessage({ channel: "general", user: "alice", text: "file thread" });
  const bytes = Buffer.from("png bytes");
  const result = await app.client.files.uploadV2({
    channel_id: "C0GENERAL0",
    thread_ts: parent.ts,
    file: bytes,
    filename: "image.png",
    title: "Image",
    initial_comment: "uploaded",
  });
  const file = (result as unknown as { files: Array<{ files: Array<Record<string, string>> }> })
    .files[0]!.files[0]!;
  expect(file.id).toBeDefined();
  const shared = await mock.waitForMessage({
    channel: "general",
    thread_ts: parent.ts,
    text: "uploaded",
  });
  expect(shared.subtype).toBe("file_share");
  expect(shared.files?.[0]?.id).toBe(file.id);
  const response = await fetch(file.url_private_download!, {
    headers: { Authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}` },
  });
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  expect((await fetch(file.url_private_download!)).status).toBe(401);
  expect((await app.client.files.info({ file: file.id! })).file?.thumb_360).toBeDefined();
});

test("human uploads deliver file_share events with authenticated downloads", async () => {
  await mock.postMessage({
    channel: "general",
    user: "alice",
    text: "human file",
    files: [{ name: "note.txt", content: "hello" }],
  });
  await mock.flush();
  const event = fileEvents.find((item) => item.text === "human file")!;
  expect(event.subtype).toBe("file_share");
  const file = (event.files as Array<{ url_private_download: string }>)[0]!;
  const response = await fetch(file.url_private_download, {
    headers: { Authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}` },
  });
  expect(await response.text()).toBe("hello");
});
