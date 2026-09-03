// Seed a workspace with varied content and keep serving it, for eyeballing the UI.
//   bun scripts/demo.ts [port]
import { SlackMock } from "../src/index.ts";

const port = Number(process.argv[2] ?? 4040);
const mock = await SlackMock.start({ port, log: true, manifest: process.env.SLACK_MANIFEST });
const bot = mock.bot.userId;
const post = (channel: string, text: string, extra: Record<string, unknown> = {}) =>
  fetch(`${mock.apiUrl}chat.postMessage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel, text, ...extra }),
  }).then((r) => r.json() as Promise<{ ts: string }>);

// A human asks, with the mrkdwn Slack actually sends.
const ask = await mock.postMessage({
  channel: "general",
  user: "alice",
  text: `<@${bot}> can you review *PR 42*? Context in <https://docs.agent-swarm.dev|the docs> :rocket:\n&gt; needs to look like Slack at a glance\n• Block Kit\n• legacy attachments\n• \`inline code\` and a block:\n\`\`\`bun test\`\`\``,
});
await mock.addReaction({ channel: "general", ts: ask.ts, name: "eyes", user: "bob" });

// The bot's thread tree, like agent-swarm's render.
const tree = await post("C0GENERAL0", "Task in progress: lead", {
  thread_ts: ask.ts,
  username: "lead",
  icon_emoji: ":crown:",
  blocks: [
    { type: "header", text: { type: "plain_text", text: "Review PR 42", emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":hourglass_flowing_sand: *lead* (`a1b2c3d4`) · running · 12s\n:white_check_mark: *worker-1* (`e5f6a7b8`) · completed · 4s",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Requested by <@U0ALICE000> · <https://cloud.agent-swarm.dev/tasks/1|open task>",
        },
      ],
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "cancel_task",
          value: "a1b2c3d4",
          style: "danger",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "View logs" },
          action_id: "view_task_logs",
          url: "https://cloud.agent-swarm.dev/tasks/1",
        },
      ],
    },
  ],
});
await post("C0GENERAL0", "Progress", {
  thread_ts: ask.ts,
  username: "worker-1",
  icon_emoji: ":robot_face:",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Findings*\n1. `src/slack/app.ts` reads `SLACK_API_URL`\n2. Tests pass (73)\n~3. Lint~ (biome crashes locally)",
      },
      fields: [
        { type: "mrkdwn", text: "*Status*\ncompleted" },
        { type: "mrkdwn", text: "*Duration*\n4s" },
      ],
    },
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_quote",
          elements: [
            {
              type: "text",
              text: "smallest diff that solves the problem",
              style: { italic: true },
            },
          ],
        },
        {
          type: "rich_text_preformatted",
          elements: [{ type: "text", text: "$ bun test\n 73 pass\n 0 fail" }],
        },
      ],
    },
  ],
  attachments: [
    {
      color: "#2eb67d",
      title: "Outcome",
      text: "Approved with one nit.",
      footer: "agent-swarm",
      ts: Math.floor(Date.now() / 1000),
    },
  ],
});
// A screenshot uploaded by the bot (1x1 png bytes).
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const file = mock.store.addFile({
  name: "diff.png",
  title: "Diff screenshot",
  user: bot,
  bytes: png,
  baseUrl: mock.baseUrl,
});
mock.store.addMessage({
  channel: "C0GENERAL0",
  user: bot,
  subtype: "file_share",
  text: "Screenshot of the diff",
  files: [file],
  thread_ts: ask.ts,
  bot_id: mock.bot.botId,
  app_id: mock.store.app.id,
});
await mock.addReaction({ channel: "general", ts: ask.ts, name: "white_check_mark", user: "alice" });
await mock.editMessage("general", tree.ts, "Task completed: lead");

// A streaming outcome card, mid-stream.
const start = await fetch(`${mock.apiUrl}chat.startStream`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    channel: "C0GENERAL0",
    thread_ts: ask.ts,
    markdown_text: "Writing the summary: the PR adds `SLACK_API_URL` support ",
  }),
}).then((r) => r.json() as Promise<{ ts: string }>);
void start;

// Top-level chatter, an ephemeral, and a DM assistant thread.
await mock.postMessage({
  channel: "general",
  user: "bob",
  text: "Thanks <@U0ALICE000>! <!here> standup in 5 :wave:",
});
await fetch(`${mock.apiUrl}chat.postEphemeral`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    channel: "C0GENERAL0",
    user: "U0ALICE000",
    text: "Only you can see this: your task was queued.",
  }),
});
const dm = await mock.startAssistantThread({
  user: "alice",
  context: { channel_id: "C0GENERAL0" },
});
await mock.postMessage({
  channel: dm.channel,
  user: "alice",
  thread_ts: dm.thread_ts,
  text: "What is the status of PR 42?",
});
await post(dm.channel, "Reviewing now, one moment.", { thread_ts: dm.thread_ts });
mock.store.assistantThread(dm.channel, dm.thread_ts).status = "is typing...";
mock.store.assistantThread(dm.channel, dm.thread_ts).title = "PR 42 status";

console.log(
  `\nDemo workspace ready:\n  ${mock.baseUrl}/\n  ${mock.baseUrl}/c/general\n  ${mock.baseUrl}/c/general/t/${ask.ts}\n  ${mock.baseUrl}/c/${dm.channel}/t/${dm.thread_ts}\n  add ?screenshot for capture mode, ?refresh=2 for live view\n`,
);
