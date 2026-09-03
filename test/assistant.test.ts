import { afterAll, beforeAll, expect, test } from "bun:test";
import { type App, Assistant } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
import { appFor } from "./helpers.ts";

let mock: SlackMock;
let app: App;
const plainMessages: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
  app = appFor(mock);
  app.assistant(
    new Assistant({
      threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
        await setSuggestedPrompts({
          title: "Ideas",
          prompts: [{ title: "Help", message: "help" }],
        });
        await saveThreadContext();
        await say("Welcome");
      },
      userMessage: async ({ message, say, setStatus, setTitle }) => {
        await setStatus("thinking");
        await setTitle("Assistant thread");
        await say(`Answer: ${(message as unknown as { text: string }).text}`);
      },
    }),
  );
  app.event("message", async ({ event }) => {
    plainMessages.push(event as unknown as Record<string, unknown>);
  });
  await app.start();
  await mock.waitForConnection();
});

afterAll(async () => {
  await app.stop();
  await mock.stop();
});

test("assistant middleware owns threaded DM messages and keeps plain DMs visible", async () => {
  const thread = await mock.startAssistantThread({
    user: "alice",
    context: { channel_id: "C0GENERAL0" },
  });
  await mock.postMessage({
    channel: thread.channel,
    user: "alice",
    thread_ts: thread.thread_ts,
    text: "help",
  });
  const reply = await mock.waitForMessage({
    channel: thread.channel,
    thread_ts: thread.thread_ts,
    from: "bot",
    text: "Answer: help",
  });
  await mock.flush();
  const state = mock.assistantThread(thread.channel, thread.thread_ts);
  expect(state.status).toBe("thinking");
  expect(state.title).toBe("Assistant thread");
  expect(state.prompts).toEqual([{ title: "Help", message: "help" }]);
  expect(reply.text).toBe("Answer: help");
  expect(plainMessages.some((message) => message.text === "help")).toBeFalse();

  await mock.postMessage({ channel: thread.channel, user: "alice", text: "plain DM" });
  await mock.flush();
  expect(
    plainMessages.some((message) => message.text === "plain DM" && message.channel_type === "im"),
  ).toBeTrue();
});
