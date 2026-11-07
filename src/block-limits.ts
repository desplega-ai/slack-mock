// Block Kit limits Slack enforces at post time, for the blocks agent cards emit.
// Source: docs.slack.dev block reference (table, data_table, data_visualization).
// Slack documents the limits but not the error strings, so the messages here are
// the mock's own wording in Slack's "[ERROR] ... [json-pointer:...]" shape.

import { SlackApiError } from "./store.ts";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Characters a cell contributes to the table budget. */
function cellChars(v: unknown): number {
  const cell = rec(v);
  if (!cell) return 0;
  if (typeof cell.text === "string") return cell.text.length;
  return arr(cell.elements).reduce<number>((n, e) => n + cellChars(e), 0);
}

function tableIssues(b: Rec, at: string, data: boolean): string[] {
  const out: string[] = [];
  const rows = arr(b.rows);
  const [minRows, maxRows, maxChars] = data ? [2, 201, 20000] : [1, 100, 10000];
  if (rows.length < minRows || rows.length > maxRows)
    out.push(`rows must have between ${minRows} and ${maxRows} items [json-pointer:${at}/rows]`);
  const cellTypes = data
    ? ["raw_text", "raw_number", "rich_text", "action_cell"]
    : ["raw_text", "raw_number", "rich_text"];
  let chars = 0;
  rows.forEach((r, i) => {
    const cells = arr(r);
    if (!Array.isArray(r) || cells.length < 1 || cells.length > 20)
      out.push(`row must have between 1 and 20 cells [json-pointer:${at}/rows/${i}]`);
    if (data && cells.length !== arr(rows[0]).length)
      out.push(`all rows must have the same number of cells [json-pointer:${at}/rows/${i}]`);
    cells.forEach((c, j) => {
      const type = str(rec(c)?.type);
      if (
        !cellTypes.includes(type) ||
        (data && i === 0 && type !== "raw_text" && type !== "raw_number")
      )
        out.push(`invalid cell type "${type}" [json-pointer:${at}/rows/${i}/${j}]`);
      chars += cellChars(c);
    });
  });
  if (chars > maxChars)
    out.push(`cells must have at most ${maxChars} characters in total [json-pointer:${at}/rows]`);
  if (data) {
    if (!str(b.caption)) out.push(`caption is required [json-pointer:${at}/caption]`);
    const page = b.page_size;
    if (
      page !== undefined &&
      !(Number.isInteger(page) && (page as number) >= 1 && (page as number) <= 100)
    )
      out.push(`page_size must be an integer between 1 and 100 [json-pointer:${at}/page_size]`);
  } else if (arr(b.column_settings).length > 20) {
    out.push(`column_settings must have at most 20 items [json-pointer:${at}/column_settings]`);
  }
  return out;
}

const label = (v: unknown) => str(v).length >= 1 && str(v).length <= 20;

function chartIssues(b: Rec, at: string): string[] {
  const out: string[] = [];
  const title = str(b.title);
  if (title.length < 1 || title.length > 50)
    out.push(`title must have between 1 and 50 characters [json-pointer:${at}/title]`);
  const chart = rec(b.chart);
  const type = str(chart?.type);
  if (type === "pie") {
    const segments = arr(chart?.segments);
    if (segments.length < 1 || segments.length > 12)
      out.push(`segments must have between 1 and 12 items [json-pointer:${at}/chart/segments]`);
    segments.forEach((s, i) => {
      const seg = rec(s);
      if (!label(seg?.label) || !(typeof seg?.value === "number" && seg.value > 0))
        out.push(
          `segment needs a 1-20 character label and a value above 0 [json-pointer:${at}/chart/segments/${i}]`,
        );
    });
    return out;
  }
  if (!["bar", "line", "area"].includes(type))
    return [...out, `chart type must be pie, bar, line or area [json-pointer:${at}/chart/type]`];
  const axis = rec(chart?.axis_config);
  const categories = arr(axis?.categories).map(str);
  if (!categories.length)
    out.push(`axis_config.categories is required [json-pointer:${at}/chart/axis_config]`);
  for (const k of ["x_label", "y_label"])
    if (str(axis?.[k]).length > 50)
      out.push(`${k} must have at most 50 characters [json-pointer:${at}/chart/axis_config/${k}]`);
  const series = arr(chart?.series);
  if (series.length < 1 || series.length > 12)
    out.push(`series must have between 1 and 12 items [json-pointer:${at}/chart/series]`);
  const names = new Set<string>();
  series.forEach((s, i) => {
    const sr = rec(s);
    const name = str(sr?.name);
    if (!label(name) || names.has(name))
      out.push(
        `series name must be unique and 1-20 characters [json-pointer:${at}/chart/series/${i}/name]`,
      );
    names.add(name);
    const data = arr(sr?.data).map((p) => rec(p));
    const labels = data.map((p) => str(p?.label));
    if (data.length < 1 || data.length > 20)
      out.push(`data must have between 1 and 20 items [json-pointer:${at}/chart/series/${i}/data]`);
    if (data.some((p) => !label(p?.label) || typeof p?.value !== "number"))
      out.push(
        `data points need a 1-20 character label and a number value [json-pointer:${at}/chart/series/${i}/data]`,
      );
    if (labels.some((l) => !categories.includes(l)) || categories.some((c) => !labels.includes(c)))
      out.push(
        `data labels must match axis_config.categories [json-pointer:${at}/chart/series/${i}/data]`,
      );
  });
  return out;
}

/** Throws `invalid_blocks` the way Slack does when a message's blocks break a limit. */
export function validateBlocks(blocks: unknown[] | undefined): void {
  if (!blocks) return;
  const issues: string[] = [];
  if (blocks.length > 50) issues.push("must have at most 50 blocks");
  let charts = 0;
  blocks.forEach((v, i) => {
    const b = rec(v);
    const at = `/blocks/${i}`;
    switch (str(b?.type)) {
      case "table":
        issues.push(...tableIssues(b as Rec, at, false));
        break;
      case "data_table":
        issues.push(...tableIssues(b as Rec, at, true));
        break;
      case "data_visualization":
        if (++charts > 2)
          issues.push(`at most 2 data_visualization blocks per message [json-pointer:${at}]`);
        issues.push(...chartIssues(b as Rec, at));
        break;
    }
  });
  if (issues.length)
    throw new SlackApiError("invalid_blocks", {
      response_metadata: { messages: issues.map((m) => `[ERROR] ${m}`) },
    });
}
