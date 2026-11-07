import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SlackMock } from "../src/index.ts";
import { renderBlocks } from "../src/render/blocks.ts";
import { Store } from "../src/store.ts";

// Block Kit produced by @json-render/chat@0.22.0 toCard + @chat-adapter/slack@4.41.1
// cardToBlockKit / cardToFallbackText (the json-render chat card path), not hand-written.
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/json-render-card.json"), "utf8"),
) as Record<"specA" | "specB" | "specC", { blocks: Record<string, unknown>[]; text: string }>;
const specs = [fixture.specA, fixture.specB, fixture.specC];

let mock: SlackMock;
const call = async (method: string, body: unknown) =>
  (await (
    await fetch(`${mock.apiUrl}${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mock.env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
  ).json()) as {
    ok: boolean;
    ts: string;
    error?: string;
    response_metadata?: { messages: string[] };
  };

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
});
afterAll(() => mock.stop());

const store = new Store({ teamId: "T0TEST", botUserId: "U0BOT", appName: "bot" });
const ctx = { users: store.users, channels: store.channels, botUserId: store.bot.userId };

describe("json-render card blocks", () => {
  test("post and update accept every block the card path emits", async () => {
    for (const { blocks, text } of specs) {
      const post = await call("chat.postMessage", { channel: "C0GENERAL0", text, blocks });
      expect(post).toMatchObject({ ok: true });
      const upd = await call("chat.update", { channel: "C0GENERAL0", ts: post.ts, text, blocks });
      expect(upd).toMatchObject({ ok: true });
    }
  });

  test("renders tables and charts instead of unsupported boxes", () => {
    const html = specs.map((s) => renderBlocks(s.blocks, ctx)).join("");
    expect(html).not.toContain("sm-unsupported");
    expect(html).toContain(`<div class="sm-table-caption">Latency by service</div>`);
    expect(html).toContain("<th>Service</th>");
    expect(html).toContain("<td>degraded</td>");
    for (const type of ["pie", "bar", "line", "area"])
      expect(html).toContain(`data-chart="${type}"`);
    expect(html).toContain(`<div class="sm-chart-title">PRs per day</div>`);
    expect(html).toContain("Merged");
  });

  test("table honours column_settings; data_table pages at page_size (default 5)", () => {
    const cell = (text: string) => ({ type: "raw_text", text });
    const rows = [
      [cell("h"), cell("n")],
      ...Array.from({ length: 7 }, (_, i) => [
        cell(`r${i}`),
        { type: "raw_number", value: i, text: String(i) },
      ]),
    ];
    const table = renderBlocks(
      [{ type: "table", rows, column_settings: [null, { align: "right", is_wrapped: true }] }],
      ctx,
    );
    expect(table).toContain(`<td class="sm-ta-right sm-td-wrap">6</td>`);
    expect(table).not.toContain("sm-table-pager");
    expect(table).not.toContain("<th"); // table has no header row in the docs
    const paged = renderBlocks([{ type: "data_table", caption: "c", rows }], ctx);
    expect(paged).toContain(`<tbody data-range="1–5 of 7"><tr><td>r0</td>`);
    expect(paged).toContain(`<tbody data-range="6–7 of 7" hidden><tr><td>r5</td>`);
    expect(paged).toContain(`<span class="sm-pager-label">1–5 of 7</span>`);
    // Out-of-range page_size on unvalidated blocks falls back to 5 instead of looping.
    expect(
      renderBlocks([{ type: "data_table", caption: "c", rows, page_size: -3 }], ctx),
    ).toContain("1–5 of 7");
    expect(
      renderBlocks([{ type: "data_table", caption: "c", rows, page_size: 10 }], ctx),
    ).not.toContain("sm-table-pager");
  });

  // Round 2 review regressions; each fails on 93815b6.
  const cell = (text: string) => ({ type: "raw_text", text });
  const btn = (text: string) => ({
    type: "action_cell",
    element: {
      type: "button",
      text: { type: "plain_text", text },
      action_id: "open",
      value: "v",
    },
  });
  const post = (blocks: unknown[]) =>
    call("chat.postMessage", { channel: "C0GENERAL0", text: "t", blocks });

  test("B1: rich_text emoji unicode is escaped, not emitted as markup", () => {
    // "<b>" as codepoints.
    const emoji = { type: "emoji", name: "nope_not_known", unicode: "3c-62-3e" };
    const rich = {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [emoji] }],
    };
    const html = renderBlocks([{ type: "table", rows: [[rich]] }, rich], ctx);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  test("B2: a data_table with 6 body rows keeps row 6 reachable", () => {
    const rows = [[cell("h")], ...Array.from({ length: 6 }, (_, i) => [cell(`r${i + 1}`)])];
    const html = renderBlocks([{ type: "data_table", caption: "c", rows }], ctx);
    expect(html).toContain("<td>r6</td>");
    expect(html).toContain(`data-step="1"`);
    expect(html).toContain(`data-range="6–6 of 6"`);
  });

  test("B3: negative chart values stay inside the plot", () => {
    const chart = (type: string) => ({
      type: "data_visualization",
      title: "t",
      chart: {
        type,
        axis_config: { categories: ["a", "b"] },
        series: [
          {
            name: "s",
            data: [
              { label: "a", value: -2 },
              { label: "b", value: 3 },
            ],
          },
        ],
      },
    });
    const svg = renderBlocks(["bar", "line", "area"].map(chart), ctx);
    for (const m of svg.matchAll(/height="(-?[\d.]+)"/g))
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
    // Plot spans y 10..190 (H 220, top 10, bottom 30).
    for (const m of svg.matchAll(/points="([^"]+)"/g))
      for (const p of (m[1] ?? "").split(" ")) {
        const y = Number(p.split(",")[1]);
        expect(y).toBeGreaterThanOrEqual(10);
        expect(y).toBeLessThanOrEqual(190);
      }
  });

  test("B4: data_table accepts action_cell in the header; rich_text is still rejected", async () => {
    const rows = [[btn("Go")], [cell("x")]];
    expect(await post([{ type: "data_table", caption: "c", rows }])).toMatchObject({ ok: true });
    const rich = { type: "rich_text", elements: [] };
    const bad = await post([{ type: "data_table", caption: "c", rows: [[rich], [cell("x")]] }]);
    expect(bad.error).toBe("invalid_blocks");
  });

  test("B5: action_cell renders its `element` button", () => {
    const html = renderBlocks(
      [{ type: "data_table", caption: "c", rows: [[cell("h")], [btn("Mark done")]] }],
      ctx,
    );
    expect(html).toContain("Mark done");
    const bad = renderBlocks(
      [
        {
          type: "data_table",
          caption: "c",
          rows: [[cell("h")], [{ type: "action_cell", element: { type: "image" } }]],
        },
      ],
      ctx,
    );
    expect(bad).not.toContain("sm-btn");
  });

  test("B6: cell budgets hold per message and count action_cell button text", async () => {
    const big = (n: number) => ({ type: "table", rows: [[cell("x".repeat(n))]] });
    const two = await post([big(6000), big(6000)]);
    expect(two.error).toBe("invalid_blocks");
    expect(two.response_metadata?.messages.join("\n")).toContain("per message");
    expect(await post([big(5000), big(5000)])).toMatchObject({ ok: true });
    const btnTable = {
      type: "data_table",
      caption: "c",
      rows: [[cell("h")], [cell("x".repeat(19990))], [btn("y".repeat(20))]],
    };
    expect((await post([btnTable])).error).toBe("invalid_blocks");
  });

  test("B7: each series needs exactly one point per category", async () => {
    const chart = (labels: string[]) => ({
      type: "data_visualization",
      title: "t",
      chart: {
        type: "bar",
        axis_config: { categories: ["a", "b"] },
        series: [{ name: "s", data: labels.map((label) => ({ label, value: 1 })) }],
      },
    });
    const dup = await post([chart(["a", "a", "b"])]);
    expect(dup.error).toBe("invalid_blocks");
    expect(dup.response_metadata?.messages.join("\n")).toContain("data labels must match");
    expect(await post([chart(["a", "b"])])).toMatchObject({ ok: true });
  });

  test("Slack's documented limits reject with invalid_blocks on post and update", async () => {
    const of = (type: string) => fixture.specA.blocks.filter((b) => b.type === type);
    const [table] = of("data_table") as [Record<string, unknown>];
    const [pie, bar] = of("data_visualization") as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const bad: [string, Record<string, unknown>[]][] = [
      ["at most 2 data_visualization blocks per message", [pie, bar, pie]],
      ["caption is required", [{ ...table, caption: undefined }]],
      [
        "rows must have between 2 and 201 items",
        [{ ...table, rows: (table.rows as unknown[]).slice(0, 1) }],
      ],
      ["title must have between 1 and 50 characters", [{ ...pie, title: "x".repeat(51) }]],
      ["value above 0", [{ ...pie, chart: { type: "pie", segments: [{ label: "a", value: 0 }] } }]],
      [
        "data labels must match axis_config.categories",
        [{ ...bar, chart: { ...(bar.chart as object), axis_config: { categories: ["Mon"] } } }],
      ],
      ["row must have between 1 and 20 cells", [{ type: "table", rows: [[]] }]],
    ];
    const ok = await call("chat.postMessage", { channel: "C0GENERAL0", text: "t", blocks: [pie] });
    for (const [message, blocks] of bad) {
      const post = await call("chat.postMessage", { channel: "C0GENERAL0", text: "t", blocks });
      expect(post.error).toBe("invalid_blocks");
      expect(post.response_metadata?.messages.join("\n")).toContain(message);
      const upd = await call("chat.update", {
        channel: "C0GENERAL0",
        ts: ok.ts,
        text: "t",
        blocks,
      });
      expect(upd.error).toBe("invalid_blocks");
    }
  });
});
