import { describe, expect, test } from "bun:test";
import { renderAttachments, renderBlocks } from "../src/render/blocks.ts";
import { renderPage } from "../src/render/index.ts";
import { mrkdwnToHtml, plainTextToHtml, type RenderContext } from "../src/render/mrkdwn.ts";
import { Store } from "../src/store.ts";

function seed() {
  const store = new Store({ teamId: "T0TEST", botUserId: "U0BOT", appName: "swarm-bot" });
  const alice = store.addUser({
    id: "U0ALICE",
    name: "alice",
    real_name: "Alice Example",
    email: "alice@example.com",
  });
  const channel = store.addChannel({
    id: "C0GEN",
    name: "general",
    creator: alice.id,
    members: [alice.id, store.bot.userId],
    topic: "Ship it",
  });
  return { store, alice, channel };
}

function ctxOf(store: Store): RenderContext {
  return { users: store.users, channels: store.channels, botUserId: store.bot.userId };
}

const { store: fixtureStore } = seed();
const ctx = ctxOf(fixtureStore);

describe("mrkdwn", () => {
  test("bold, italic, strike and inline code", () => {
    const html = mrkdwnToHtml("*bold* _italic_ ~gone~ `code()`", ctx);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain(`<code class="sm-code">code()</code>`);
  });

  test("underscores inside a word are not italics", () => {
    expect(mrkdwnToHtml("call some_long_name now", ctx)).toBe("call some_long_name now");
  });

  test("fenced preformatted block keeps newlines", () => {
    const html = mrkdwnToHtml("before\n```\nline one\nline two\n```\nafter", ctx);
    expect(html).toContain(`<pre class="sm-pre">line one\nline two</pre>`);
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  test("consecutive quote lines merge into one blockquote", () => {
    const html = mrkdwnToHtml("&gt; first\n&gt; second\nplain", ctx);
    expect(html).toContain(`<blockquote class="sm-quote">first<br>second</blockquote>`);
    expect(html).toContain("plain");
    expect(html.match(/<blockquote/g)?.length).toBe(1);
  });

  test("links with and without a label", () => {
    expect(mrkdwnToHtml("<https://agent-swarm.dev|Docs>", ctx)).toBe(
      `<a class="sm-link" href="https://agent-swarm.dev" target="_blank" rel="noopener">Docs</a>`,
    );
    expect(mrkdwnToHtml("<https://agent-swarm.dev>", ctx)).toContain(
      ">https://agent-swarm.dev</a>",
    );
    expect(mrkdwnToHtml("<mailto:a@b.dev|mail me>", ctx)).toBe(
      `<a class="sm-link" href="mailto:a@b.dev">mail me</a>`,
    );
  });

  test("a code span inside a link label survives tokenising", () => {
    const html = mrkdwnToHtml("(<https://app.dev/tasks/1|`1a2b3c4d`>)", ctx);
    expect(html).toContain(`<code class="sm-code">1a2b3c4d</code></a>`);
    expect(html).not.toContain(String.fromCharCode(0xe000));
  });

  test("user mentions resolve through the store, unknown ids fall back", () => {
    expect(mrkdwnToHtml("hi <@U0ALICE>", ctx)).toBe(`hi <span class="sm-pill">@alice</span>`);
    expect(mrkdwnToHtml("hi <@U0NOBODY>", ctx)).toContain("@U0NOBODY");
  });

  test("channel mentions, broadcasts, usergroups and dates", () => {
    expect(mrkdwnToHtml("see <#C0GEN|general>", ctx)).toContain(
      `<span class="sm-pill">#general</span>`,
    );
    expect(mrkdwnToHtml("see <#C0GEN>", ctx)).toContain("#general");
    expect(mrkdwnToHtml("<!here> please", ctx)).toContain(`<span class="sm-pill">@here</span>`);
    expect(mrkdwnToHtml("<!channel>", ctx)).toContain("@channel");
    expect(mrkdwnToHtml("<!subteam^S1|@ops>", ctx)).toContain("@ops");
    expect(mrkdwnToHtml("<!date^1700000000^{date_short}|Nov 14, 2023>", ctx)).toBe("Nov 14, 2023");
  });

  test("emoji shortcodes: known map to unicode, unknown stay muted", () => {
    expect(mrkdwnToHtml("ship it :rocket: :white_check_mark:", ctx)).toBe("ship it 🚀 ✅");
    expect(mrkdwnToHtml(":not_a_real_emoji:", ctx)).toBe(
      `<span class="sm-emoji-name">:not_a_real_emoji:</span>`,
    );
  });

  test("already escaped entities are not escaped twice", () => {
    const html = mrkdwnToHtml("Tom &amp; Jerry &lt;tag&gt;", ctx);
    expect(html).toBe("Tom &amp; Jerry &lt;tag&gt;");
    expect(html).not.toContain("&amp;amp;");
  });

  test("raw angle brackets in code stay literal", () => {
    expect(mrkdwnToHtml("`a &lt; b`", ctx)).toBe(`<code class="sm-code">a &lt; b</code>`);
  });

  test("bullet and numbered lists", () => {
    expect(mrkdwnToHtml("• one\n- two\n* three", ctx)).toBe(
      `<ul class="sm-list"><li>one</li><li>two</li><li>three</li></ul>`,
    );
    expect(mrkdwnToHtml("1. one\n2. two", ctx)).toBe(
      `<ol class="sm-list"><li>one</li><li>two</li></ol>`,
    );
  });

  test("single newlines become line breaks", () => {
    expect(mrkdwnToHtml("a\nb", ctx)).toBe("a<br>b");
  });

  test("plainTextToHtml escapes and renders emoji only", () => {
    expect(plainTextToHtml("Cancel *now* :fire: &amp; go")).toBe("Cancel *now* 🔥 &amp; go");
  });
});

describe("blocks", () => {
  test("header block", () => {
    const html = renderBlocks(
      [{ type: "header", text: { type: "plain_text", text: "Status" } }],
      ctx,
    );
    expect(html).toContain(`class="sm-block sm-header-block"`);
    expect(html).toContain("Status");
  });

  test("section with fields and a button accessory", () => {
    const html = renderBlocks(
      [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Alpha* finished" },
          fields: [
            { type: "mrkdwn", text: "*Duration*\n2m 14s" },
            { type: "mrkdwn", text: "*Cost*\n$0.12" },
          ],
          accessory: { type: "button", text: { type: "plain_text", text: "Open" }, action_id: "o" },
        },
      ],
      ctx,
    );
    expect(html).toContain("<strong>Alpha</strong>");
    expect(html).toContain(`class="sm-fields"`);
    expect(html).toContain("2m 14s");
    expect(html).toContain(`class="sm-section-acc"`);
    expect(html).toContain("Open");
  });

  test("context block renders muted text and inline images", () => {
    const html = renderBlocks(
      [
        {
          type: "context",
          elements: [
            { type: "image", image_url: "https://example.dev/i.png", alt_text: "icon" },
            { type: "mrkdwn", text: "Alpha · <https://app.dev/t/1|`1a2b`>" },
          ],
        },
      ],
      ctx,
    );
    expect(html).toContain(`class="sm-block sm-context"`);
    expect(html).toContain(`class="sm-context-img"`);
    expect(html).toContain("https://app.dev/t/1");
  });

  test("actions: button styles and url buttons", () => {
    const html = renderBlocks(
      [
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Go" } },
            { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" } },
            {
              type: "button",
              style: "danger",
              text: { type: "plain_text", text: "Cancel" },
              confirm: { title: { type: "plain_text", text: "Sure?" } },
            },
            {
              type: "button",
              url: "https://app.dev/task/1",
              text: { type: "plain_text", text: "View task" },
            },
            { type: "static_select", placeholder: { type: "plain_text", text: "Pick one" } },
          ],
        },
      ],
      ctx,
    );
    expect(html).toContain(`class="sm-btn"`);
    expect(html).toContain("sm-btn-primary");
    expect(html).toContain("sm-btn-danger");
    expect(html).toContain(`<a class="sm-btn" href="https://app.dev/task/1"`);
    expect(html).toContain("Pick one");
  });

  test("image block with title and alt text", () => {
    const html = renderBlocks(
      [
        {
          type: "image",
          title: { type: "plain_text", text: "Chart" },
          image_url: "https://example.dev/c.png",
          alt_text: "a chart",
        },
      ],
      ctx,
    );
    expect(html).toContain("Chart");
    expect(html).toContain(`src="https://example.dev/c.png"`);
    expect(html).toContain(`alt="a chart"`);
  });

  test("rich_text with a bulleted list, styles and mentions", () => {
    const html = renderBlocks(
      [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              indent: 0,
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "text", text: "build", style: { bold: true } },
                    { type: "text", text: " then ping " },
                    { type: "user", user_id: "U0ALICE" },
                  ],
                },
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "emoji", name: "rocket" },
                    { type: "text", text: " ship" },
                  ],
                },
              ],
            },
          ],
        },
      ],
      ctx,
    );
    expect(html).toContain(`<ul class="sm-list"`);
    expect(html).toContain("<strong>build</strong>");
    expect(html).toContain("@alice");
    expect(html).toContain("🚀");
  });

  test("divider and unknown blocks", () => {
    expect(renderBlocks([{ type: "divider" }], ctx)).toContain(`class="sm-hr"`);
    const html = renderBlocks([{ type: "llama_block", foo: 1 }], ctx);
    expect(html).toContain("unsupported: llama_block");
  });

  test("input block for modal views", () => {
    const html = renderBlocks(
      [
        {
          type: "input",
          block_id: "follow_up_input",
          label: { type: "plain_text", text: "Follow-up message" },
          element: {
            type: "plain_text_input",
            multiline: true,
            placeholder: { type: "plain_text", text: "What next?" },
          },
        },
      ],
      ctx,
    );
    expect(html).toContain("Follow-up message");
    expect(html).toContain("sm-input-multi");
    expect(html).toContain("What next?");
  });
});

describe("attachments", () => {
  test("color bar, title link, text and fields", () => {
    const html = renderAttachments(
      [
        {
          color: "#36a64f",
          pretext: "Heads up",
          author_name: "Datadog",
          title: "CPU high",
          title_link: "https://app.datadoghq.com/e/1",
          text: "*host-1* is at 98%",
          fields: [
            { title: "Env", value: "prod", short: true },
            { title: "Region", value: "eu-1", short: true },
          ],
          footer: "Datadog",
          ts: 1700000000,
        },
      ],
      ctx,
    );
    expect(html).toContain("border-left-color:#36a64f");
    expect(html).toContain("Heads up");
    expect(html).toContain(`href="https://app.datadoghq.com/e/1"`);
    expect(html).toContain("CPU high");
    expect(html).toContain("<strong>host-1</strong>");
    expect(html).toContain("prod");
    expect(html).toContain("Datadog");
  });

  test("named colors and default bar", () => {
    expect(renderAttachments([{ color: "danger", text: "boom" }], ctx)).toContain(
      "border-left-color:#e01e5a",
    );
    expect(renderAttachments([{ text: "plain" }], ctx)).toContain("border-left-color:#dddddd");
  });
});

describe("renderPage", () => {
  function workspace() {
    const { store, alice, channel } = seed();
    const human = store.addMessage({
      channel: channel.id,
      user: alice.id,
      text: "Hey <@U0BOT> please deploy :rocket:",
    });
    const file = store.addFile({
      name: "shot.png",
      user: store.bot.userId,
      bytes: new Uint8Array([137, 80, 78, 71]),
      baseUrl: "http://127.0.0.1:1234",
    });
    const reply = store.addMessage({
      channel: channel.id,
      user: store.bot.userId,
      bot_id: store.bot.botId,
      username: "Alpha",
      icons: { emoji: ":robot_face:" },
      thread_ts: human.ts,
      text: "Deployed to prod",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ *Deployed* to prod" } }],
      files: [file],
    });
    store.addReaction(channel.id, reply.ts, "white_check_mark", alice.id);
    store.addMessage({
      channel: channel.id,
      user: store.bot.userId,
      text: "only you can see this",
      ephemeral_user: alice.id,
    });
    return { store, channel, human, reply };
  }

  test("index page lists channels and users", () => {
    const { store } = workspace();
    const html = renderPage(store, { kind: "index" }, { connections: 2 });
    expect(html).toContain("Mock Workspace");
    expect(html).toContain("T0TEST");
    expect(html).toContain("U0BOT");
    expect(html).toContain(">2<");
    expect(html).toContain("general");
    expect(html).toContain("alice@example.com");
    expect(html).toContain(`href="/c/C0GEN"`);
  });

  test("channel page shows the top-level message, reply count and ephemerals", () => {
    const { store, channel } = workspace();
    const html = renderPage(store, { kind: "channel", channel: channel.id });
    expect(html).toContain("please deploy");
    expect(html).toContain("🚀");
    expect(html).toContain("1 reply");
    expect(html).toContain("Alice Example");
    expect(html).toContain("Only visible to you");
    expect(html).toContain("sm-msg-eph");
    // Thread replies stay out of the channel view.
    expect(html).not.toContain("Deployed</strong>");
  });

  test("thread page shows the parent and the reply with blocks, files and reactions", () => {
    const { store, channel, human } = workspace();
    const html = renderPage(store, { kind: "thread", channel: channel.id, ts: human.ts });
    expect(html).toContain("please deploy");
    expect(html).toContain("<strong>Deployed</strong>");
    expect(html).toContain("Alpha");
    expect(html).toContain("APP");
    expect(html).toContain("🤖");
    expect(html).toContain("shot.png");
    expect(html).toContain("sm-file-img");
    // url_private needs a token in the query, the mock refuses unauthenticated downloads.
    expect(html).toContain("t=xoxb-mock-bot-token");
    expect(html).toContain("sm-reaction");
    expect(html).toContain("✅");
    // The thread pane itself never shows ephemerals; only the channel column does.
    const shot = renderPage(
      store,
      { kind: "thread", channel: channel.id, ts: human.ts },
      { screenshot: true },
    );
    expect(shot).not.toContain("Only visible to you");
  });

  test("thread page renders the channel next to a thread side panel", () => {
    const { store, channel, human } = workspace();
    const html = renderPage(store, { kind: "thread", channel: channel.id, ts: human.ts });
    expect(html).toContain(`<div class="sm-app sm-app-thread">`);
    expect(html).toContain(`<nav class="sm-side">`);
    expect(html).toContain(`<aside class="sm-panel">`);
    expect(html).toContain(`<h2 class="sm-panel-title">Thread</h2>`);
    expect(html).toContain(`<a class="sm-panel-close" href="/c/C0GEN" title="Close thread">×</a>`);
    expect(html).toContain(`<a class="sm-panel-back" href="/c/C0GEN">← #general</a>`);
    // The open thread's parent is highlighted in the channel column.
    expect(html).toContain("sm-msg-open");
    // Parent shown twice: once in the channel column, once in the panel.
    expect(html.match(/please deploy/g)?.length).toBe(2);
  });

  test("screenshot thread page stays thread-only", () => {
    const { store, channel, human } = workspace();
    const html = renderPage(
      store,
      { kind: "thread", channel: channel.id, ts: human.ts },
      { screenshot: true },
    );
    expect(html).not.toContain(`<nav class="sm-side">`);
    expect(html).not.toContain(`<aside class="sm-panel">`);
    expect(html).not.toContain(`class="sm-msg sm-msg-open"`);
    expect(html).toContain(`<div class="sm-shot">`);
  });

  test("channel and thread headers link back to the workspace", () => {
    const { store, channel, human } = workspace();
    const channelHtml = renderPage(store, { kind: "channel", channel: channel.id });
    expect(channelHtml).toContain(`<a class="sm-back" href="/">← Workspace</a>`);
    const threadHtml = renderPage(store, { kind: "thread", channel: channel.id, ts: human.ts });
    expect(threadHtml).toContain(`<a class="sm-back" href="/">← Workspace</a>`);
    const refreshed = renderPage(
      store,
      { kind: "channel", channel: channel.id },
      { refreshSec: 3 },
    );
    expect(refreshed).toContain(`<a class="sm-back" href="/?refresh=3">← Workspace</a>`);
    // Screenshot captures stay free of navigation chrome.
    const shot = renderPage(store, { kind: "channel", channel: channel.id }, { screenshot: true });
    expect(shot).not.toContain(`<a class="sm-back"`);
  });

  test("screenshot mode drops the sidebar and keeps links prefixed", () => {
    const { store, channel } = workspace();
    const html = renderPage(store, { kind: "channel", channel: channel.id }, { screenshot: true });
    expect(html).not.toContain(`<nav class="sm-side">`);
    expect(html).not.toContain(`class="sm-app"`);
    expect(html).toContain(`<div class="sm-shot">`);
    expect(html).toContain("?screenshot");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("refresh meta tag only outside screenshot mode", () => {
    const { store, channel } = workspace();
    const live = renderPage(store, { kind: "channel", channel: channel.id }, { refreshSec: 2 });
    expect(live).toContain(`<meta http-equiv="refresh" content="2">`);
    expect(live).toContain("?refresh=2");
  });

  test("assistant thread status, title and prompts", () => {
    const { store, channel, human } = workspace();
    const thread = store.assistantThread(channel.id, human.ts);
    thread.status = "is thinking";
    thread.title = "Deploy request";
    thread.prompts = [{ title: "Roll back", message: "roll back the deploy" }];
    const html = renderPage(store, { kind: "thread", channel: channel.id, ts: human.ts });
    expect(html).toContain("Deploy request");
    expect(html).toContain("is thinking");
    expect(html).toContain("Roll back");
    expect(html).toContain("sm-prompt");
  });

  test("streaming messages show the pulsing indicator", () => {
    const { store, channel } = workspace();
    store.addMessage({
      channel: channel.id,
      user: store.bot.userId,
      bot_id: store.bot.botId,
      text: "thinking",
      streaming_state: "in_progress",
    });
    const html = renderPage(store, { kind: "channel", channel: channel.id });
    expect(html).toContain("sm-stream");
  });

  test("empty channel and missing message states", () => {
    const { store } = seed();
    const quiet = store.addChannel({ id: "C0QUIET", name: "quiet" });
    expect(renderPage(store, { kind: "channel", channel: quiet.id })).toContain("No messages yet");
    expect(renderPage(store, { kind: "thread", channel: quiet.id, ts: "1.1" })).toContain(
      "Message not found",
    );
  });

  test("panel width defaults to 50% and follows panelWidth", () => {
    const { store, channel, human } = workspace();
    const view = { kind: "thread", channel: channel.id, ts: human.ts } as const;
    expect(renderPage(store, view)).toContain(`<body style="--sm-panel-w:50%">`);
    const wide = renderPage(store, view, { panelWidth: "70%" });
    expect(wide).toContain(`<body style="--sm-panel-w:70%">`);
    // The width rides along in links so the next thread keeps it.
    expect(wide).toContain("panel=70");
    const px = renderPage(store, view, { panelWidth: "640px" });
    expect(px).toContain(`<body style="--sm-panel-w:640px">`);
    expect(px).toContain("panel=640px");
    // Junk falls back to the default.
    expect(renderPage(store, view, { panelWidth: "url(evil)" })).toContain(
      `<body style="--sm-panel-w:50%">`,
    );
  });

  test("full thread view drops the channel column and offers collapse", () => {
    const { store, channel, human } = workspace();
    const html = renderPage(
      store,
      { kind: "thread", channel: channel.id, ts: human.ts },
      { threadView: "full" },
    );
    expect(html).not.toContain(`<aside class="sm-panel">`);
    expect(html).not.toContain(`class="sm-msg sm-msg-open"`);
    expect(html).toContain(`<nav class="sm-side">`);
    expect(html).toContain("Collapse to panel");
    expect(html).toContain(`<a class="sm-back" href="/c/C0GEN">← #general</a>`);
    // Parent appears once: there is no channel column beside the thread.
    expect(html.match(/please deploy/g)?.length).toBe(1);
    // Collapse drops ?full but keeps the rest.
    const withRefresh = renderPage(
      store,
      { kind: "thread", channel: channel.id, ts: human.ts },
      { threadView: "full", refreshSec: 2, panelWidth: "70%" },
    );
    expect(withRefresh).toContain(`href="/c/C0GEN/t/${human.ts}?refresh=2&panel=70"`);
  });

  test("panel mode links to the full view", () => {
    const { store, channel, human } = workspace();
    const html = renderPage(store, { kind: "thread", channel: channel.id, ts: human.ts });
    expect(html).toContain(
      `<a class="sm-panel-expand" href="/c/C0GEN/t/${human.ts}?full" title="Expand thread">⤢</a>`,
    );
  });

  test("Escape closes the thread, only outside screenshot mode", () => {
    const { store, channel, human } = workspace();
    const view = { kind: "thread", channel: channel.id, ts: human.ts } as const;
    const panel = renderPage(store, view);
    expect(panel).toContain(`e.key==="Escape"`);
    expect(panel).toContain(`location.href="/c/C0GEN"`);
    const full = renderPage(store, view, { threadView: "full" });
    expect(full).toContain(`e.key==="Escape"`);
    expect(renderPage(store, view, { screenshot: true })).not.toContain("Escape");
  });

  test("composer posts to /mock/messages from the channel and the thread", () => {
    const { store, channel, human } = workspace();
    const channelHtml = renderPage(store, { kind: "channel", channel: channel.id });
    expect(channelHtml).toContain(`<div class="sm-composer" data-channel="C0GEN">`);
    expect(channelHtml).toContain(`<select class="sm-composer-user"`);
    expect(channelHtml).toContain(`<option value="U0ALICE" selected>Alice Example</option>`);
    // Bots never appear in the composer.
    expect(channelHtml).not.toContain(`<option value="U0BOT"`);
    expect(channelHtml).toContain(`<textarea class="sm-composer-text"`);
    expect(channelHtml).toContain("Message #general");
    expect(channelHtml).toContain("Enter to send, Shift+Enter for a new line, @name to mention");
    expect(channelHtml).toContain(`fetch("/mock/messages"`);

    const threadHtml = renderPage(store, { kind: "thread", channel: channel.id, ts: human.ts });
    expect(threadHtml).toContain(
      `<div class="sm-composer" data-channel="C0GEN" data-thread="${human.ts}">`,
    );
    expect(threadHtml).toContain("Reply in thread");

    const fullHtml = renderPage(
      store,
      { kind: "thread", channel: channel.id, ts: human.ts },
      { threadView: "full" },
    );
    expect(fullHtml).toContain(`data-thread="${human.ts}"`);
  });

  test("screenshot pages have no composer", () => {
    const { store, channel, human } = workspace();
    const shotChannel = renderPage(
      store,
      { kind: "channel", channel: channel.id },
      { screenshot: true },
    );
    const shotThread = renderPage(
      store,
      { kind: "thread", channel: channel.id, ts: human.ts },
      { screenshot: true },
    );
    for (const html of [shotChannel, shotThread]) {
      expect(html).not.toContain(`class="sm-composer"`);
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("<script>");
    }
  });
});
