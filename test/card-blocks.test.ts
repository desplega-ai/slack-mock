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
    expect(paged).toContain("<td>r4</td>");
    expect(paged).not.toContain("<td>r5</td>");
    expect(paged).toContain("1–5 of 7");
    expect(
      renderBlocks([{ type: "data_table", caption: "c", rows, page_size: 10 }], ctx),
    ).not.toContain("sm-table-pager");
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
