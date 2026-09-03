// Slack mrkdwn -> HTML.
//
// Message text arrives with `&`, `<` and `>` already escaped by Slack, except
// inside the `<...>` control sequences (links, mentions, specials). The renderer
// therefore tokenises code spans and control sequences first, then normalises the
// remaining entities back to characters and escapes them once. That keeps
// `&amp;` a single `&amp;` in the output instead of `&amp;amp;`.

import type { SlackChannel, SlackUser } from "../types.ts";

export interface RenderContext {
  users: Map<string, SlackUser>;
  channels: Map<string, SlackChannel>;
  botUserId: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Slack-escaped text (`&amp;` `&lt;` `&gt;`) back to plain characters, one pass. */
function unescapeSlack(s: string): string {
  return s.replace(/&(amp|lt|gt|quot);/g, (_m, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : '"',
  );
}

/** Escape text that came off the wire already Slack-escaped. */
function reEscape(s: string): string {
  return escapeHtml(unescapeSlack(s));
}

const EMOJI: Record<string, string> = {
  eyes: "👀",
  white_check_mark: "✅",
  x: "❌",
  heavy_plus_sign: "➕",
  heavy_minus_sign: "➖",
  heavy_multiplication_x: "✖️",
  zap: "⚡",
  speech_balloon: "💬",
  robot_face: "🤖",
  gear: "⚙️",
  rocket: "🚀",
  star: "⭐",
  crystal_ball: "🔮",
  bulb: "💡",
  wrench: "🔧",
  hammer: "🔨",
  crown: "👑",
  tada: "🎉",
  warning: "⚠️",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  thumbsup: "👍",
  thumbsdown: "👎",
  "+1": "👍",
  "-1": "👎",
  heavy_check_mark: "✔️",
  question: "❓",
  grey_question: "❔",
  exclamation: "❗",
  white_circle: "⚪",
  large_blue_circle: "🔵",
  black_circle: "⚫",
  red_circle: "🔴",
  large_green_circle: "🟢",
  large_yellow_circle: "🟡",
  fire: "🔥",
  sparkles: "✨",
  memo: "📝",
  clipboard: "📋",
  mag: "🔍",
  mag_right: "🔎",
  link: "🔗",
  lock: "🔒",
  unlock: "🔓",
  bell: "🔔",
  package: "📦",
  construction: "🚧",
  bug: "🐛",
  boom: "💥",
  pencil2: "✏️",
  scroll: "📜",
  page_facing_up: "📄",
  file_folder: "📁",
  card_index_dividers: "🗂️",
  paperclip: "📎",
  bar_chart: "📊",
  chart_with_upwards_trend: "📈",
  calendar: "📅",
  clock1: "🕐",
  arrow_right: "➡️",
  arrow_left: "⬅️",
  arrow_up: "⬆️",
  arrow_down: "⬇️",
  arrow_right_hook: "↪️",
  repeat: "🔁",
  arrows_counterclockwise: "🔄",
  recycle: "♻️",
  no_entry: "⛔",
  no_entry_sign: "🚫",
  stop_sign: "🛑",
  pause_button: "⏸️",
  information_source: "ℹ️",
  wave: "👋",
  pray: "🙏",
  muscle: "💪",
  brain: "🧠",
  dart: "🎯",
  trophy: "🏆",
  medal: "🏅",
  checkered_flag: "🏁",
  ok_hand: "👌",
  point_right: "👉",
  clap: "👏",
  raised_hands: "🙌",
  thinking_face: "🤔",
  "100": "💯",
  green_heart: "💚",
  thread: "🧵",
  satellite_antenna: "📡",
  inbox_tray: "📥",
  outbox_tray: "📤",
  incoming_envelope: "📨",
  mailbox_with_no_mail: "📭",
  envelope: "✉️",
  test_tube: "🧪",
  ship: "🚢",
  sos: "🆘",
  small_blue_diamond: "🔹",
  small_orange_diamond: "🔸",
  black_small_square: "▪️",
  white_small_square: "▫️",
};

/** Unicode character for a Slack emoji shortcode, or undefined when unknown. */
export function emojiChar(name: string): string | undefined {
  return EMOJI[name.replace(/^:|:$/g, "").replace(/::skin-tone-\d$/, "")];
}

/** Codepoint list from a rich_text emoji element, e.g. "1f44b" or "1f1ea-1f1f8". */
export function emojiFromUnicode(code: string): string | undefined {
  const points = code.split("-").map((p) => Number.parseInt(p, 16));
  if (points.some((p) => !Number.isFinite(p))) return undefined;
  try {
    return String.fromCodePoint(...points);
  } catch {
    return undefined;
  }
}

/** Replace `:shortcode:` in already-escaped HTML text. */
function renderEmoji(html: string): string {
  return html.replace(/:([a-z][a-z0-9_+'-]*|\+1|-1|100):/g, (m, name: string) => {
    const char = emojiChar(name);
    return char ?? `<span class="sm-emoji-name">${m}</span>`;
  });
}

export function displayName(user: SlackUser): string {
  return user.profile.display_name || user.real_name || user.name;
}

function pill(text: string): string {
  return `<span class="sm-pill">${escapeHtml(text)}</span>`;
}

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:|tel:)/i.test(url);
}

/** One `<...>` control sequence: mention, channel, special or link. */
function renderControl(inner: string, ctx: RenderContext): string {
  const bar = inner.indexOf("|");
  const head = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? inner.slice(bar + 1) : "";

  if (head.startsWith("@")) {
    const id = head.slice(1);
    const user = ctx.users.get(id);
    return pill(`@${user ? displayName(user) : label || id}`);
  }
  if (head.startsWith("#")) {
    const id = head.slice(1);
    const channel = ctx.channels.get(id);
    return pill(`#${channel ? channel.name : label.replace(/^#/, "") || id}`);
  }
  if (head.startsWith("!")) {
    const cmd = head.slice(1);
    if (cmd === "here" || cmd === "channel" || cmd === "everyone") return pill(`@${cmd}`);
    if (cmd.startsWith("subteam^")) {
      const handle = label || cmd.slice("subteam^".length);
      return pill(handle.startsWith("@") ? handle : `@${handle}`);
    }
    if (cmd.startsWith("date^")) {
      if (label) return renderEmoji(reEscape(label));
      const secs = Number(cmd.split("^")[1]);
      return Number.isFinite(secs) ? escapeHtml(new Date(secs * 1000).toISOString()) : "";
    }
    return pill(`@${cmd}`);
  }
  if (isSafeUrl(head)) {
    const shown = label || head.replace(/^mailto:/i, "");
    const attrs = /^mailto:/i.test(head) ? "" : ' target="_blank" rel="noopener"';
    return `<a class="sm-link" href="${escapeHtml(head)}"${attrs}>${renderEmoji(reEscape(shown))}</a>`;
  }
  return escapeHtml(`<${unescapeSlack(inner)}>`);
}

function preHtml(body: string): string {
  let code = body.replace(/^\n/, "").replace(/\n$/, "");
  // Strip a leading language tag (```ts) when the fence spans several lines.
  if (code.includes("\n")) code = code.replace(/^[a-z][a-z0-9+#-]{0,11}\n/, "");
  return `<pre class="sm-pre">${reEscape(code)}</pre>`;
}

const BOUND_L = "(^|[\\s(\\[{'\"\\uE000\\uE001])";
const BOUND_R = "(?=$|[\\s.,;:!?)\\]}'\"\\uE000\\uE001])";

function styleRule(marker: string): RegExp {
  const m = marker.replace(/[*]/g, "\\*");
  return new RegExp(`${BOUND_L}${m}(?![\\s${m}])([^${m}\\n]*[^\\s${m}])${m}${BOUND_R}`, "g");
}

const RULES: Array<[RegExp, string]> = [
  [styleRule("*"), "strong"],
  [styleRule("~"), "s"],
  [styleRule("_"), "em"],
];

function inlineStyles(s: string): string {
  let out = s;
  for (const [re, tag] of RULES) out = out.replace(re, `$1<${tag}>$2</${tag}>`);
  return out;
}

interface Group {
  kind: "p" | "quote" | "ul" | "ol";
  items: Array<{ html: string; indent: number }>;
}

const QUOTE = /^\s*(?:&gt;|>)\s?/;
const BULLET = /^(\s*)(?:•|-|\*)\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;

/** Split lines into blockquote / list / paragraph groups and emit HTML. */
function blockify(text: string): string {
  const groups: Group[] = [];
  const push = (kind: Group["kind"], html: string, indent = 0) => {
    const last = groups[groups.length - 1];
    if (last?.kind === kind) last.items.push({ html, indent });
    else groups.push({ kind, items: [{ html, indent }] });
  };
  for (const line of text.split("\n")) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBER.exec(line);
    if (QUOTE.test(line)) push("quote", line.replace(QUOTE, ""));
    else if (bullet)
      push("ul", bullet[2] ?? "", Math.min(4, Math.floor((bullet[1]?.length ?? 0) / 2)));
    else if (numbered)
      push("ol", numbered[2] ?? "", Math.min(4, Math.floor((numbered[1]?.length ?? 0) / 2)));
    else push("p", line);
  }
  return groups
    .map((g) => {
      if (g.kind === "p") return g.items.map((i) => i.html).join("<br>");
      const inner = g.items
        .map(
          (i) => `<li${i.indent ? ` style="margin-left:${i.indent * 18}px"` : ""}>${i.html}</li>`,
        )
        .join("");
      if (g.kind === "quote")
        return `<blockquote class="sm-quote">${g.items.map((i) => i.html).join("<br>")}</blockquote>`;
      return `<${g.kind} class="sm-list">${inner}</${g.kind}>`;
    })
    .join("");
}

const BLOCK_TAGS = "pre|blockquote|ul|ol";

function tidy(html: string): string {
  return html
    .replace(new RegExp(`<br>\\s*(<(?:${BLOCK_TAGS})\\b)`, "g"), "$1")
    .replace(new RegExp(`(</(?:${BLOCK_TAGS})>)\\s*<br>`, "g"), "$1");
}

/** Render Slack mrkdwn to HTML. */
export function mrkdwnToHtml(text: string, ctx: RenderContext): string {
  if (!text) return "";
  const tokens: string[] = [];
  const hold = (html: string): string => {
    tokens.push(html);
    return `\uE000${tokens.length - 1}\uE001`;
  };

  let s = text.replace(/\r\n/g, "\n");
  s = s.replace(/```([\s\S]*?)```/g, (_m, body: string) => hold(preHtml(body)));
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) =>
    hold(`<code class="sm-code">${reEscape(body)}</code>`),
  );
  s = s.replace(/<([^<>\n]*)>/g, (_m, inner: string) => hold(renderControl(inner, ctx)));
  s = renderEmoji(reEscape(s));
  s = inlineStyles(s);
  s = blockify(s);
  // Tokens can nest (a code span inside a link label), so expand recursively.
  // Every token only refers to earlier tokens, which bounds the recursion.
  const expand = (html: string): string =>
    html.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => expand(tokens[Number(i)] ?? ""));
  return tidy(expand(s));
}

/** plain_text objects: escaping and emoji only, no formatting. */
export function plainTextToHtml(text: string): string {
  if (!text) return "";
  return renderEmoji(reEscape(text.replace(/\r\n/g, "\n"))).replace(/\n/g, "<br>");
}
