import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
import { renderBlocks } from "../src/render/blocks.ts";
import { Store } from "../src/store.ts";
import { appFor } from "./helpers.ts";

// The shape Slack documents for feedback buttons under an AI answer.
const feedback = {
  type: "context_actions",
  elements: [
    {
      type: "feedback_buttons",
      action_id: "rate",
      positive_button: {
        text: { type: "plain_text", text: "Good <answer>" },
        accessibility_label: "Mark as good",
        value: "up:1",
      },
      negative_button: { text: { type: "plain_text", text: "Bad answer" }, value: "down:1" },
    },
    {
      type: "icon_button",
      icon: "trash",
      action_id: "del",
      text: { type: "plain_text", text: "Delete" },
    },
  ],
};

const store = new Store({ teamId: "T0TEST", botUserId: "U0BOT", appName: "bot" });
const ctx = { users: store.users, channels: store.channels, botUserId: store.bot.userId };

describe("context_actions", () => {
  test("renders feedback buttons and icon buttons, not unsupported boxes", () => {
    const html = renderBlocks([feedback], ctx);
    expect(html).not.toContain("sm-unsupported");
    expect(html).toContain('class="sm-block sm-context-actions"');
    expect(html).toContain('title="Good &lt;answer&gt;" aria-label="Mark as good">👍</span>');
    expect(html).toContain('title="Bad answer" aria-label="Bad answer">👎</span>');
    expect(html).toContain("🗑 Delete");
    expect(
      renderBlocks([{ type: "context_actions", elements: [{ type: "nope" }] }], ctx),
    ).toContain("unsupported: nope");
  });

  describe("clicks", () => {
    let mock: SlackMock;
    let app: App;
    const actions: Array<Record<string, unknown>> = [];

    beforeAll(async () => {
      mock = await SlackMock.start({ port: 0 });
      app = appFor(mock);
      app.action("rate", async ({ ack, action }) => {
        actions.push(action as unknown as Record<string, unknown>);
        await ack();
      });
      await app.start();
      await mock.waitForConnection();
    });

    afterAll(async () => {
      await app.stop();
      await mock.stop();
    });

    test("a click delivers a feedback_buttons action with the clicked side's value", async () => {
      const posted = await app.client.chat.postMessage({
        channel: "C0GENERAL0",
        text: "answer",
        blocks: [feedback],
      });
      await mock.clickButton({ channel: "general", ts: posted.ts!, action_id: "rate" });
      await mock.clickButton({
        channel: "general",
        ts: posted.ts!,
        action_id: "rate",
        value: "down:1",
      });
      expect(actions.map((a) => [a.type, a.value])).toEqual([
        ["feedback_buttons", "up:1"],
        ["feedback_buttons", "down:1"],
      ]);
    });
  });
});
