import { describe, expect, test } from "bun:test";
import { knownLink } from "../src/render/chips.ts";
import { THEMES } from "../src/render/css.ts";
import { renderPage } from "../src/render/index.ts";
import { mrkdwnToHtml, type RenderContext } from "../src/render/mrkdwn.ts";
import { SlackMock } from "../src/server.ts";
import { Store } from "../src/store.ts";

function workspace() {
  const store = new Store({ botUserId: "U0BOT", appName: "Agent Swarm" });
  const alice = store.addUser({ id: "U0ALICE", name: "alice", real_name: "Alice Example" });
  const channel = store.addChannel({ id: "C0GEN", name: "general", members: [alice.id] });
  const ctx: RenderContext = {
    users: store.users,
    channels: store.channels,
    botUserId: store.bot.userId,
    linkStates: store.linkStates,
  };
  return { store, alice, channel, ctx };
}

describe("link chips", () => {
  const PR = "https://github.com/desplega-ai/agent-swarm/pull/3432";

  test("known URLs get an icon and a short label", () => {
    expect(knownLink(PR)).toMatchObject({ icon: "github", label: "agent-swarm#3432" });
    expect(knownLink("https://github.com/desplega-ai/slack-mock/issues/7")).toMatchObject({
      label: "slack-mock#7",
      kind: "issue",
    });
    expect(knownLink("https://github.com/o/r/commit/3ec7f5b2f6aa")?.label).toBe("r@3ec7f5b");
    expect(knownLink("https://github.com/desplega-ai/slack-mock")?.label).toBe(
      "desplega-ai/slack-mock",
    );
    expect(knownLink("https://linear.app/acme/issue/eng-42/some-title")?.label).toBe("ENG-42");
    expect(knownLink("https://app.agent-swarm.dev/tasks/48c12581-1df2-46d3")?.label).toBe(
      "Task 48c12581",
    );
    expect(knownLink("https://app.agent-swarm.dev/apps/dc22fd7f-cafc")?.icon).toBe("app");
    expect(
      knownLink("https://app.agent-swarm.dev/file/~/org/drive/shared/notes/v2.md"),
    ).toMatchObject({ icon: "file", label: "v2.md" });
  });

  test("other URLs stay plain links", () => {
    for (const url of [
      "https://agent-swarm.dev",
      "https://github.com/settings/tokens",
      "https://github.com/o/r/pull/abc",
      "https://example.test/tasks/1",
      "mailto:a@b.dev",
    ])
      expect(knownLink(url)).toBeUndefined();
  });

  test("a chip keeps the href, prefers the written label and shows a known PR state", () => {
    const { store, ctx } = workspace();
    const bare = mrkdwnToHtml(`see <${PR}>`, ctx);
    expect(bare).toContain(`<a class="sm-link sm-chip" href="${PR}" target="_blank"`);
    expect(bare).toContain(`<span class="sm-chip-label">agent-swarm#3432</span>`);
    expect(bare).not.toContain("sm-chip-state");
    expect(mrkdwnToHtml(`<${PR}|the fix>`, ctx)).toContain(
      `<span class="sm-chip-label">the fix</span>`,
    );
    store.linkStates.set(PR, "merged");
    expect(mrkdwnToHtml(`<${PR}>`, ctx)).toContain(`class="sm-chip-state sm-chip-merged"`);
  });

  test("a label cannot inject markup into a chip", () => {
    const { ctx } = workspace();
    const html = mrkdwnToHtml(`<${PR}|&lt;img src=x onerror=alert(1)&gt;>`, ctx);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("themes", () => {
  test("light is the default, dark is opt-in, and both carry the Hive sidebar values", () => {
    const { store, channel } = workspace();
    const view = { kind: "channel", channel: channel.id } as const;
    const light = renderPage(store, view);
    expect(light).toContain(`<html lang="en" data-theme="light">`);
    for (const name of ["light", "dark"] as const) {
      const [column, , active] = THEMES[name].split(",");
      expect(light).toContain(`--t-col:${column}`);
      expect(light).toContain(`--t-active:${active}`);
    }
    expect(light).toContain(`href="/c/C0GEN"`);
    expect(light).toContain(`class="sm-tb-btn sm-theme-toggle" href="?theme=dark"`);

    const dark = renderPage(store, view, { theme: "dark" });
    expect(dark).toContain(`data-theme="dark"`);
    // The page's theme rides along on its links, so it survives navigation and live refresh.
    expect(dark).toContain(`href="/c/C0GEN?theme=dark"`);
    expect(dark).toContain(`href="?theme=light"`);

    expect(renderPage(store, view, { defaultTheme: "dark" })).toContain(`data-theme="dark"`);
    expect(renderPage(store, view, { theme: "neon" })).toContain(`data-theme="light"`);
    expect(renderPage(store, view, { theme: "dark", screenshot: true })).toContain(
      `data-theme="dark"`,
    );
  });

  test("the server takes the theme from its option and from ?theme=, and serves the font", async () => {
    const mock = await SlackMock.start({ port: 0, theme: "dark", log: false });
    try {
      const page = async (query: string) =>
        (await fetch(`${mock.baseUrl}/c/general${query}`)).text();
      expect(await page("")).toContain(`data-theme="dark"`);
      expect(await page("?theme=light")).toContain(`data-theme="light"`);
      // Served pages link the font; screenshot pages inline it so a capture never waits on it.
      expect(await page("")).toContain(`url(/fonts/lato-400.woff2)`);
      expect(await page("?screenshot")).toContain("url(data:font/woff2;base64,");
      const font = await fetch(`${mock.baseUrl}/fonts/lato-900.woff2`);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(
        Buffer.from(await font.arrayBuffer())
          .subarray(0, 4)
          .toString(),
      ).toBe("wOF2");
      expect((await fetch(`${mock.baseUrl}/fonts/lato-123.woff2`)).status).toBe(404);
    } finally {
      await mock.stop();
    }
  });
});

describe("message list", () => {
  test("a message minutes after one by the same author drops the avatar and name", () => {
    const { store, alice, channel } = workspace();
    const post = (user: string, ts: string, text: string) =>
      store.addMessage({ channel: channel.id, user, text, ts });
    post(alice.id, "1700000000.000001", "first");
    post(alice.id, "1700000060.000002", "second");
    post(store.bot.userId, "1700000090.000003", "other author");
    post(alice.id, "1700000900.000004", "much later");
    const html = renderPage(store, { kind: "channel", channel: channel.id }, { screenshot: true });
    const classes = [...html.matchAll(/<div class="(sm-msg[^"]*)" data-ts/g)].map((m) => m[1]);
    expect(classes).toEqual(["sm-msg", "sm-msg sm-msg-cont", "sm-msg", "sm-msg"]);
    expect(html.match(/class="sm-name"/g)?.length).toBe(3);
  });

  test("the add-reaction pill is not a reaction: the page script reads a count from those", () => {
    const { store, alice, channel } = workspace();
    const message = store.addMessage({ channel: channel.id, user: alice.id, text: "hi" });
    store.addReaction(channel.id, message.ts, "eyes", alice.id);
    const html = renderPage(store, { kind: "channel", channel: channel.id });
    expect(html).toContain(`class="sm-add-reaction sm-reaction-more"`);
    expect(html).not.toMatch(/class="sm-add-reaction[^"]* sm-reaction[ "]/);
  });

  test("profile pictures replace initials for users and for the app", () => {
    const store = new Store({ botUserId: "U0BOT", appIcon: "https://cdn.test/app.png" });
    const dana = store.addUser({ name: "dana", image: "https://cdn.test/dana.jpg" });
    const channel = store.addChannel({ id: "C0GEN", name: "general", members: [dana.id] });
    store.addMessage({ channel: channel.id, user: dana.id, text: `hi <@${store.bot.userId}>` });
    const html = renderPage(store, { kind: "channel", channel: channel.id });
    expect(html).toContain(`<span class="sm-avatar"><img src="https://cdn.test/dana.jpg" alt="">`);
    expect(html).toContain(`<span class="sm-chip-av"><img src="https://cdn.test/app.png" alt="">`);
    expect(store.users.get(dana.id)?.profile.image_72).toBe("https://cdn.test/dana.jpg");
  });

  test("no em dash in the UI copy", () => {
    const { store, alice, channel } = workspace();
    const message = store.addMessage({ channel: channel.id, user: alice.id, text: "hi" });
    for (const view of [
      { kind: "index" },
      { kind: "channel", channel: channel.id },
      { kind: "thread", channel: channel.id, ts: message.ts },
    ] as const)
      expect(renderPage(store, view)).not.toContain("—");
  });
});
