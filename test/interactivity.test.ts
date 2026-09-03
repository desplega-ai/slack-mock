import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
import { appFor, errorCode } from "./helpers.ts";

describe("slash commands and block actions", () => {
  let mock: SlackMock;
  let app: App;
  let action: Record<string, unknown> | undefined;
  let view: Record<string, unknown> | undefined;

  beforeAll(async () => {
    mock = await SlackMock.start({ port: 0 });
    app = appFor(mock);
    app.command("/hello", async ({ ack, respond }) => {
      await ack({ text: "ack text" });
      await respond({ response_type: "ephemeral", text: "via response_url" });
    });
    app.command("/public", async ({ ack, respond }) => {
      await ack();
      await respond({ response_type: "in_channel", text: "public response" });
    });
    app.action("do_it", async ({ ack, body, client }) => {
      action = body as unknown as Record<string, unknown>;
      await ack();
      await client.views.open({
        trigger_id: (body as unknown as { trigger_id: string }).trigger_id,
        view: {
          type: "modal",
          callback_id: "my_modal",
          private_metadata: "pm",
          title: { type: "plain_text", text: "T" },
          submit: { type: "plain_text", text: "Go" },
          blocks: [
            {
              type: "input",
              block_id: "b1",
              label: { type: "plain_text", text: "L" },
              element: { type: "plain_text_input", action_id: "a1" },
            },
          ],
        },
      });
    });
    app.view("my_modal", async ({ ack, body }) => {
      view = body.view as unknown as Record<string, unknown>;
      await ack();
    });
    await app.start();
    await mock.waitForConnection();
  });

  afterAll(async () => {
    await app.stop();
    await mock.stop();
  });

  test("slash command ack and response_url messages preserve visibility", async () => {
    const result = await mock.slashCommand({
      command: "/hello",
      text: "x",
      user: "alice",
      channel: "C0GENERAL0",
    });
    expect((result.ack.payload as { text: string }).text).toBe("ack text");
    expect(result.response?.ephemeral_user).toBe("U0ALICE000");
    await mock.flush();
    expect(
      mock.ephemeralMessages("general").some((message) => message.text === "via response_url"),
    ).toBeTrue();
    await mock.slashCommand({ command: "/public", channel: "general" });
    await mock.flush();
    expect(
      mock.messages("general").some((message) => message.text === "public response"),
    ).toBeTrue();
  });

  test("button actions open views and view submissions preserve values", async () => {
    const posted = await app.client.chat.postMessage({
      channel: "C0GENERAL0",
      text: "click",
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "do_it",
              value: "42",
              text: { type: "plain_text", text: "Do" },
            },
          ],
        },
      ],
    });
    await mock.clickButton({
      channel: "general",
      ts: posted.ts!,
      action_id: "do_it",
      user: "alice",
    });
    await mock.waitForApiCall("views.open");
    const handledAction = action!;
    expect((handledAction.actions as Array<{ value: string }>)[0]?.value).toBe("42");
    expect((handledAction.message as { ts: string }).ts).toBe(posted.ts!);
    await mock.submitView({
      callback_id: "my_modal",
      values: { b1: { a1: { type: "plain_text_input", value: "hello" } } },
    });
    const submittedView = view!;
    expect(submittedView.private_metadata).toBe("pm");
    expect(
      (submittedView.state as { values: { b1: { a1: { value: string } } } }).values.b1.a1.value,
    ).toBe("hello");
  });
});

test("expired trigger IDs reject delayed views.open calls", async () => {
  const mock = await SlackMock.start({ port: 0, triggerIdTtlMs: 50 });
  const app = appFor(mock);
  let failure: unknown;
  app.action("late", async ({ ack, body, client }) => {
    await ack();
    await Bun.sleep(200);
    try {
      await client.views.open({
        trigger_id: (body as unknown as { trigger_id: string }).trigger_id,
        view: { type: "modal", title: { type: "plain_text", text: "T" }, blocks: [] },
      });
    } catch (error) {
      failure = error;
    }
  });
  await app.start();
  await mock.waitForConnection();
  const message = await app.client.chat.postMessage({
    channel: "C0GENERAL0",
    text: "late",
    blocks: [
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "late", text: { type: "plain_text", text: "Late" } },
        ],
      },
    ],
  });
  await mock.clickButton({ channel: "general", ts: message.ts!, action_id: "late" });
  await mock.waitForApiCall("views.open", { where: (call) => !call.ok });
  const deadline = Date.now() + 1_000;
  while (failure === undefined && Date.now() < deadline) await Bun.sleep(10);
  expect(errorCode(failure)).toBe("expired_trigger_id");
  await app.stop();
  await mock.stop();
});
