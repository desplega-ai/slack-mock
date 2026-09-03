// A tiny Bolt app that makes the hosted demo feel alive: it reacts to mentions,
// replies in threads with a Block Kit card, updates it, answers DMs and the
// assistant pane, and handles the Cancel button.
import { App, Assistant, LogLevel } from "@slack/bolt";
import type { SlackMock } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function card(state: "working" | "done" | "cancelled", ask: string, who: string) {
  const line =
    state === "working"
      ? `:hourglass_flowing_sand: *demo-bot* · working · 0s`
      : state === "done"
        ? `:white_check_mark: *demo-bot* · completed · 2s`
        : `:x: *demo-bot* · cancelled`;
  return [
    {
      type: "header",
      text: { type: "plain_text", text: ask.slice(0, 120) || "Untitled task", emoji: true },
    },
    { type: "section", text: { type: "mrkdwn", text: line } },
    ...(state === "done"
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Here is what I would do about *${ask}*:\n• read the thread\n• run \`bun test\`\n• post this card and flip the reaction`,
            },
          },
        ]
      : []),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Requested by <@${who}> · <https://github.com/desplega-ai/slack-mock|slack-mock on GitHub>`,
        },
      ],
    },
    ...(state === "working"
      ? [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                action_id: "cancel_task",
                value: "demo",
                style: "danger",
              },
            ],
          },
        ]
      : []),
  ];
}

export async function startDemoBot(mock: SlackMock): Promise<App> {
  const app = new App({
    token: mock.env.SLACK_BOT_TOKEN,
    appToken: mock.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.ERROR,
    clientOptions: { slackApiUrl: `${mock.localUrl}/api/` },
  });
  const cancelled = new Set<string>();

  app.event("app_mention", async ({ event, client, say }) => {
    const ask = event.text.replace(/<@[^>]+>/g, "").trim();
    const threadTs = event.thread_ts ?? event.ts;
    await client.reactions
      .add({ channel: event.channel, timestamp: event.ts, name: "eyes" })
      .catch(() => {});
    const posted = await say({
      thread_ts: threadTs,
      text: `Working on: ${ask}`,
      blocks: card("working", ask, event.user ?? ""),
    });
    await sleep(2500);
    if (!posted.ts || cancelled.has(posted.ts)) return;
    await client.chat.update({
      channel: event.channel,
      ts: posted.ts,
      text: `Done: ${ask}`,
      blocks: card("done", ask, event.user ?? ""),
    });
    await client.reactions
      .remove({ channel: event.channel, timestamp: event.ts, name: "eyes" })
      .catch(() => {});
    await client.reactions
      .add({ channel: event.channel, timestamp: event.ts, name: "white_check_mark" })
      .catch(() => {});
  });

  app.action("cancel_task", async ({ ack, body, client }) => {
    await ack();
    const b = body as { channel?: { id: string }; message?: { ts: string }; user: { id: string } };
    if (!b.channel || !b.message) return;
    cancelled.add(b.message.ts);
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: "Cancelled",
      blocks: card("cancelled", "Cancelled", b.user.id),
    });
  });

  app.message(async ({ message, say }) => {
    const m = message as {
      channel_type?: string;
      subtype?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      user?: string;
    };
    if (m.channel_type !== "im" || m.subtype || !m.text) return;
    await say({
      thread_ts: m.thread_ts ?? m.ts,
      text: `You said: _${m.text}_. Mention me in <#C0GENERAL0> to see a task card.`,
    });
  });

  app.assistant(
    new Assistant({
      threadStarted: async ({ say, setSuggestedPrompts }) => {
        await say("Hi! I am the slack-mock demo bot. Ask me anything.");
        await setSuggestedPrompts({
          title: "Try these",
          prompts: [
            { title: "Status", message: "What is the status?" },
            { title: "Help", message: "help" },
          ],
        });
      },
      userMessage: async ({ message, say, setStatus, setTitle }) => {
        const text = (message as { text?: string }).text ?? "";
        await setStatus("is thinking...");
        await setTitle(text.slice(0, 40) || "Chat");
        await sleep(800);
        await say(
          `Got it: *${text}*. In a real app this thread would be handled by your assistant.`,
        );
        await setStatus("");
      },
    }),
  );

  await app.start();
  return app;
}
