// Server-rendered HTML for the mock workspace, laid out like the Slack desktop client. Screenshot
// pages carry no client-side JavaScript and no external assets (the font is inlined), so a page
// can be screenshotted by headless Chrome or opened from a file while debugging a test.

import type { Store } from "../store.ts";
import type { SlackChannel, SlackFile, SlackMessage, SlackUser } from "../types.ts";
import { renderAttachments, renderBlocks } from "./blocks.ts";
import { avatarColor, initials, userAvatar, userImage } from "./chips.ts";
import { fontPreloads, stylesheet, THEMES, type ThemeName } from "./css.ts";
import { icon } from "./icons.ts";
import {
  displayName,
  emojiChar,
  escapeHtml,
  markdownToHtml,
  mrkdwnToHtml,
  plainTextToHtml,
  type RenderContext,
} from "./mrkdwn.ts";

export { escapeHtml } from "./mrkdwn.ts";

export type View =
  | { kind: "index" }
  | { kind: "channel"; channel: string }
  | { kind: "thread"; channel: string; ts: string };

export interface RenderOptions {
  /** Screenshot mode: no navigation chrome, fixed width, no auto-refresh. */
  screenshot?: boolean;
  /** Number of live Socket Mode connections (shown on the index page). */
  connections?: number;
  /** Auto-refresh interval in seconds (omit for none). */
  refreshSec?: number;
  /** CSS width of the thread side panel. Default "50%", never below 360px. */
  panelWidth?: string;
  /** "panel" (default) shows the thread beside the channel, "full" shows it alone. */
  threadView?: "panel" | "full";
  /** Push changes over SSE and flash new messages (default true; `?live=0` turns it off). */
  live?: boolean;
  /** Reading is open but posting needs a credential: the composer shows a presenter sign-in. */
  writeGated?: boolean;
  /** "light" or "dark" for this page. Links on the page carry it, so it survives navigation. */
  theme?: string;
  /** The theme when `theme` is unset. Falls back to `SLACK_MOCK_THEME`, then "light". */
  defaultTheme?: string;
  /** URL prefix the Lato font files load from. Unset: the font is inlined in the page. */
  fontBase?: string;
}

const DEFAULT_PANEL_WIDTH = "50%";

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

function ctxOf(store: Store): RenderContext {
  return {
    users: store.users,
    channels: store.channels,
    botUserId: store.bot.userId,
    linkStates: store.linkStates,
  };
}

function themeOf(opts: RenderOptions): ThemeName {
  for (const name of [opts.theme, opts.defaultTheme, process.env.SLACK_MOCK_THEME])
    if (name && Object.hasOwn(THEMES, name)) return name as ThemeName;
  return "light";
}

/** A CSS width the page can trust, or the default. */
function panelWidth(opts: RenderOptions): string {
  const raw = (opts.panelWidth ?? "").trim();
  return /^\d{1,4}(%|px|vw|rem)$/.test(raw) ? raw : DEFAULT_PANEL_WIDTH;
}

/** The `?panel=` form of a width: "60%" -> "60", "640px" -> "640px". */
function panelParam(opts: RenderOptions): string {
  const width = (opts.panelWidth ?? "").trim();
  if (!/^\d{1,4}(%|px|vw|rem)$/.test(width) || width === DEFAULT_PANEL_WIDTH) return "";
  return width.endsWith("%") ? width.slice(0, -1) : width;
}

/** Query string for links, carrying screenshot / refresh / panel / full / theme. */
function query(opts: RenderOptions, over: { full?: boolean; theme?: ThemeName } = {}): string {
  const theme = over.theme ?? (opts.theme && themeOf(opts));
  if (opts.screenshot) return theme ? `?screenshot&theme=${theme}` : "?screenshot";
  const parts: string[] = [];
  if (opts.refreshSec) parts.push(`refresh=${opts.refreshSec}`);
  const panel = panelParam(opts);
  if (panel) parts.push(`panel=${panel}`);
  if (over.full ?? opts.threadView === "full") parts.push("full");
  if (theme) parts.push(`theme=${theme}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Channel pages have no thread, so they never carry `full`. */
function channelHref(channelId: string, opts: RenderOptions): string {
  return `/c/${encodeURIComponent(channelId)}${query(opts, { full: false })}`;
}

function homeHref(opts: RenderOptions): string {
  return `/${query(opts, { full: false })}`;
}

function threadHref(
  channelId: string,
  ts: string,
  opts: RenderOptions,
  over: { full?: boolean } = {},
): string {
  return `/c/${encodeURIComponent(channelId)}/t/${encodeURIComponent(ts)}${query(opts, over)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timeOf(ts: string): string {
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: string): string {
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return "Today";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  // Slack writes "Friday, October 20th".
  const day = d.getDate();
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return `${DAY_FORMAT.format(d)}${suffix}`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function channelLabel(store: Store, c: SlackChannel): string {
  if (!c.is_im) return `#${c.name}`;
  const peer = c.user ? store.users.get(c.user) : undefined;
  return peer ? peer.real_name || displayName(peer) : c.name;
}

function channelIcon(c: SlackChannel): string {
  if (c.is_im) return "@";
  if (c.is_private) return "🔒";
  return "#";
}

/** A small square avatar (sidebar rows, member stack, thread repliers). */
function face(user: SlackUser, cls = "sm-face"): string {
  const { inner, style } = userAvatar(user);
  return `<span class="${cls}"${style}>${inner}</span>`;
}

function channelKind(c: SlackChannel): string {
  if (c.is_im) return "DM";
  if (c.is_private) return "private";
  return "public";
}

// ------------------------------------------------------------------ message

function authorName(store: Store, m: SlackMessage): string {
  if (m.username) return m.username;
  const user = m.user ? store.users.get(m.user) : undefined;
  if (user) return user.real_name || user.name;
  return m.bot_profile?.name ?? m.user ?? "unknown";
}

function avatarHtml(store: Store, m: SlackMessage, name: string): string {
  const emojiName = m.icons?.emoji;
  if (emojiName) {
    const char = emojiChar(emojiName) ?? emojiName.replace(/:/g, "");
    return `<div class="sm-avatar sm-avatar-emoji">${escapeHtml(char)}</div>`;
  }
  const imageUrl = m.icons?.image_72 ?? m.icons?.image_48 ?? m.icons?.image_64;
  if (imageUrl && /^(https?:\/\/|\/)/.test(imageUrl)) {
    return `<div class="sm-avatar"><img src="${escapeHtml(imageUrl)}" alt=""></div>`;
  }
  // A custom username is another persona, so the user's own picture does not apply.
  const user = m.user && !m.username ? store.users.get(m.user) : undefined;
  if (user) return face(user, "sm-avatar");
  const seed = m.user ?? m.bot_id ?? name;
  return `<div class="sm-avatar" style="background:${avatarColor(seed)}">${escapeHtml(initials(name))}</div>`;
}

function reactionsHtml(
  store: Store,
  m: SlackMessage,
  interactive: boolean,
  locked: boolean,
): string {
  if (!m.reactions?.length) return "";
  const chips = m.reactions.map((r) => {
    const who = r.users
      .map((id) => {
        const user = store.users.get(id);
        return user ? displayName(user) : id;
      })
      .join(", ");
    const char = emojiChar(r.name) ?? `:${r.name}:`;
    const content = `${escapeHtml(char)}<span class="sm-reaction-count">${r.count}</span>`;
    return interactive
      ? `<button type="button" class="sm-reaction" title="${escapeHtml(who)}" data-reaction="${escapeHtml(r.name)}" data-users="${escapeHtml(JSON.stringify(r.users))}" aria-label="Add :${escapeHtml(r.name)}: reaction, ${r.count} ${r.count === 1 ? "person" : "people"} reacted" aria-pressed="false"${locked ? " disabled" : ""}>${content}</button>`
      : `<span class="sm-reaction" title="${escapeHtml(who)}">${content}</span>`;
  });
  // Slack ends the row with an "add reaction" pill. It is not a `sm-reaction`: the page script
  // reads a count from each of those.
  const add = interactive
    ? `<button type="button" class="sm-add-reaction sm-reaction-more" aria-label="Add reaction" aria-haspopup="dialog" aria-controls="sm-reaction-picker" title="Add reaction"${locked ? " disabled" : ""}>${icon("emojiPlus", 16)}</button>`
    : `<span class="sm-reaction-more">${icon("emojiPlus", 16)}</span>`;
  return `<div class="sm-reactions">${chips.join("")}${add}</div>`;
}

const QUICK_REACTIONS = ["white_check_mark", "eyes", "raised_hands"];

/** The hover toolbar: three quick reactions, the picker, the thread, and Slack's other icons. */
function messageActions(m: SlackMessage, opts: RenderOptions): string {
  const thread = m.thread_ts ?? m.ts;
  const disabled = opts.writeGated ? " disabled" : "";
  const quick = QUICK_REACTIONS.map(
    (name) =>
      `<button type="button" class="sm-quick" data-reaction="${name}" aria-label="React with ${name.replaceAll("_", " ")}" title=":${name}:"${disabled}>${emojiChar(name)}</button>`,
  ).join("");
  const inert = ["share", "bookmark", "moreVertical"]
    .map((name) => `<span aria-hidden="true">${icon(name)}</span>`)
    .join("");
  return `<div class="sm-message-actions">${quick}<button type="button" class="sm-add-reaction" aria-label="Add reaction" aria-haspopup="dialog" aria-controls="sm-reaction-picker" title="Add reaction"${disabled}>${icon("emojiPlus")}</button><a class="sm-reply-action" href="${threadHref(m.channel, thread, opts)}" data-thread="${escapeHtml(thread)}" aria-label="Open thread" title="Open thread">${icon("thread")}</a>${inert}</div><div class="sm-action-error" role="alert" hidden></div>`;
}

function reactionPicker(): string {
  const names = [
    "thumbsup",
    "green_heart",
    "eyes",
    "white_check_mark",
    "tada",
    "rocket",
    "star",
    "thinking_face",
    "sparkles",
    "fire",
    "raised_hands",
    "clap",
  ];
  const buttons = names
    .map(
      (name) =>
        `<button type="button" data-reaction="${name}" aria-label="React with ${name.replaceAll("_", " ")}" title=":${name}:">${escapeHtml(emojiChar(name) ?? `:${name}:`)}</button>`,
    )
    .join("");
  return `<dialog class="sm-reaction-picker" id="sm-reaction-picker" aria-labelledby="sm-reaction-title"><div class="sm-reaction-picker-head"><h2 id="sm-reaction-title">Add a reaction</h2><button type="button" class="sm-reaction-close" aria-label="Close reactions">✕</button></div><div class="sm-reaction-choices">${buttons}</div><div class="sm-action-error" role="alert" hidden></div></dialog>`;
}

/** The mock serves url_private behind a token, so browser requests carry it in the query. */
function fileUrl(f: SlackFile, token: string): string {
  if (!f.url_private) return "";
  return escapeHtml(`${f.url_private}${f.url_private.includes("?") ? "&" : "?"}t=${token}`);
}

function filesHtml(files: SlackFile[] | undefined, token: string): string {
  if (!files?.length) return "";
  const cards = files.map((f) => {
    if (f.mimetype?.startsWith("image/") && f.url_private) {
      return `<img class="sm-file-img" src="${fileUrl(f, token)}" alt="${escapeHtml(f.title || f.name)}">`;
    }
    const href = fileUrl(f, token);
    const name = escapeHtml(f.title || f.name);
    const meta = `${escapeHtml(f.pretty_type || f.filetype || "File")} · ${fileSize(f.size ?? 0)}`;
    const label = href ? `<a href="${href}">${name}</a>` : name;
    return `<div class="sm-file-card"><div class="sm-file-icon">${icon("file")}</div><div><div class="sm-file-name">${label}</div><div class="sm-file-meta">${meta}</div></div></div>`;
  });
  return `<div class="sm-files">${cards.join("")}</div>`;
}

interface MessageFlags {
  ephemeral?: boolean;
  threadLink?: boolean;
  /** Date dividers between days (channel view only, like Slack). */
  dividers?: boolean;
  /** ts of the message whose thread is open in the side panel. */
  openTs?: string;
  /** Same author as the message above, minutes apart: no avatar and no name line. */
  cont?: boolean;
}

/** Up to five distinct repliers of a thread, in reply order. */
function replyFaces(store: Store, m: SlackMessage): string {
  const seen = new Set<string>();
  for (const reply of store.replies(m.channel, m.ts, { limit: 1000 }).items.slice(1))
    if (reply.user && store.users.has(reply.user)) seen.add(reply.user);
  const faces = [...seen].slice(0, 5).map((id) => face(store.users.get(id)!));
  return faces.length ? `<span class="sm-replies-faces">${faces.join("")}</span>` : "";
}

function lastReply(ts: string): string {
  const days = Math.floor((Date.now() / 1000 - Number(ts)) / 86_400);
  if (dayLabel(ts) === "Today") return `today at ${timeOf(ts)}`;
  return days <= 1 ? "1 day ago" : `${days} days ago`;
}

function renderMessage(
  store: Store,
  ctx: RenderContext,
  m: SlackMessage,
  opts: RenderOptions,
  flags: MessageFlags = {},
): string {
  const name = authorName(store, m);
  const isApp = Boolean(m.bot_id);
  const blocks = Array.isArray(m.blocks) && m.blocks.length ? m.blocks : undefined;
  const interactive = !opts.screenshot && !flags.ephemeral && humanUsers(store).length > 0;
  const body: string[] = [];
  if (m.streaming_state !== undefined && !m.stream_replaced) {
    // A streamed message (chat.startStream) keeps its Markdown body; the blocks handed to
    // chat.stopStream are appended below it, like Slack does. Once chat.update replaces the
    // blocks (agent-swarm resends the answer as a `markdown` block), they carry the body and
    // the message renders like a posted one.
    if (m.text) body.push(`<div class="sm-text">${markdownToHtml(m.text, ctx)}</div>`);
    if (blocks) body.push(renderBlocks(blocks, ctx));
  } else if (blocks) body.push(renderBlocks(blocks, ctx));
  else if (m.text)
    body.push(
      `<div class="sm-text">${m.text_format === "markdown" ? markdownToHtml(m.text, ctx) : mrkdwnToHtml(m.text, ctx)}</div>`,
    );
  if (m.edited) body.push(`<div class="sm-edited">(edited)</div>`);
  if (m.attachments?.length) body.push(renderAttachments(m.attachments, ctx));
  body.push(filesHtml(m.files, store.bot.token));
  body.push(reactionsHtml(store, m, interactive, Boolean(opts.writeGated)));
  if (flags.threadLink && m.reply_count) {
    const count = `${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`;
    const last = m.latest_reply
      ? `<span class="sm-replies-time">Last reply ${lastReply(m.latest_reply)}</span>`
      : "";
    body.push(
      `<a class="sm-replies" href="${threadHref(m.channel, m.thread_ts ?? m.ts, opts)}">${replyFaces(store, m)}<span class="sm-replies-count">${count}</span>${last}<span class="sm-replies-view">View thread</span><span class="sm-replies-go">${icon("chevronRight", 16)}</span></a>`,
    );
  }
  if (interactive) body.push(messageActions(m, opts));
  const streaming =
    m.streaming_state === "in_progress"
      ? `<span class="sm-stream" title="streaming">•••</span>`
      : "";
  const open = flags.openTs && flags.openTs === m.ts ? " sm-msg-open" : "";
  const note = flags.ephemeral ? `<div class="sm-eph-note">Only visible to you</div>` : "";
  const head = flags.cont
    ? streaming
    : `${note}<div class="sm-msg-head"><span class="sm-name">${escapeHtml(name)}</span>${isApp ? `<span class="sm-badge">APP</span>` : ""}<span class="sm-time">${timeOf(m.ts)}</span>${streaming}</div>`;
  const gutter = flags.cont
    ? `<div class="sm-gutter">${timeOf(m.ts)}</div>`
    : avatarHtml(store, m, name);
  return `<div class="sm-msg${flags.ephemeral ? " sm-msg-eph" : ""}${open}${flags.cont ? " sm-msg-cont" : ""}" data-ts="${escapeHtml(m.ts)}" data-channel="${escapeHtml(m.channel)}">${gutter}<div class="sm-msg-body">${head}${body.join("")}</div></div>`;
}

/** Slack groups a message under the one above when the author matches and it came within minutes. */
function continues(prev: SlackMessage | undefined, m: SlackMessage): boolean {
  if (!prev) return false;
  const same = prev.user === m.user && prev.bot_id === m.bot_id && prev.username === m.username;
  return same && Number(m.ts) - Number(prev.ts) < 300;
}

function renderMessageList(
  store: Store,
  ctx: RenderContext,
  messages: Array<SlackMessage & { _ephemeral?: boolean }>,
  opts: RenderOptions,
  flags: MessageFlags = {},
): string {
  const out: string[] = [];
  let day = "";
  let prev: SlackMessage | undefined;
  for (const m of messages) {
    const label = flags.dividers === false ? "" : dayLabel(m.ts);
    if (label && label !== day) {
      day = label;
      prev = undefined;
      out.push(
        `<div class="sm-daydiv"><span>${escapeHtml(label)}${icon("chevronDown", 14)}</span></div>`,
      );
    }
    const ephemeral = m._ephemeral === true;
    out.push(
      renderMessage(store, ctx, m, opts, {
        ...flags,
        ephemeral,
        cont: !ephemeral && continues(prev, m),
      }),
    );
    prev = ephemeral ? undefined : m;
  }
  return out.join("");
}

// -------------------------------------------------------------------- shell

function sortedChannels(store: Store): SlackChannel[] {
  return [...store.channels.values()].sort((a, b) =>
    channelLabel(store, a).localeCompare(channelLabel(store, b)),
  );
}

/** Phones: the workspace name, the "post as" pick and a channel switcher in one top bar. */
function mobileBar(store: Store, opts: RenderOptions, active?: string): string {
  const options = sortedChannels(store)
    .map(
      (c) =>
        `<option value="${escapeHtml(channelHref(c.id, opts))}"${c.id === active ? " selected" : ""}>${escapeHtml(channelLabel(store, c))}</option>`,
    )
    .join("");
  return `<div class="sm-mobile-bar"><div class="sm-mobile-heading"><a class="sm-mobile-workspace" href="${homeHref(opts)}">${escapeHtml(store.team.name)}</a>${identityChip(store, opts)}</div><select class="sm-channel-switch" aria-label="Channel"><option value="${homeHref(opts)}"${active ? "" : " selected"}>Workspace</option>${options}</select></div>`;
}

/** Rows that only complete the picture (Threads, Huddles, the rail tabs) stay out of the a11y tree. */
function inertRow(glyph: string, label: string): string {
  return `<span class="sm-row" aria-hidden="true"><span class="sm-row-ic">${glyph}</span><span class="sm-row-name">${escapeHtml(label)}</span></span>`;
}

function sidebar(store: Store, opts: RenderOptions, active?: string): string {
  const row = (c: SlackChannel) => {
    const peer = c.is_im && c.user ? store.users.get(c.user) : undefined;
    const glyph = peer
      ? `${face(peer, "sm-row-av")}<span class="sm-presence"></span>`
      : icon(c.is_private ? "lock" : "hash", 16);
    return `<a class="sm-row${c.id === active ? " sm-active" : ""}" href="${channelHref(c.id, opts)}"><span class="sm-row-ic">${glyph}</span><span class="sm-row-name">${escapeHtml(c.is_im ? channelLabel(store, c) : c.name)}</span></a>`;
  };
  const section = (label: string, rows: string) =>
    rows ? `<div class="sm-side-h">${icon("caretDown", 16)}${label}</div>${rows}` : "";
  const channels = sortedChannels(store);
  const bot = store.users.get(store.bot.userId);
  const title = `<div class="sm-side-title"><a href="${homeHref(opts)}"><span>${escapeHtml(store.team.name)}</span>${icon("chevronDown", 16)}</a><span class="sm-side-tools" aria-hidden="true"><span>${icon("filter", 18)}</span><span>${icon("compose", 18)}</span></span></div>`;
  const top = `${inertRow(icon("thread", 16), "Threads")}${inertRow(icon("headphones", 16), "Huddles")}${inertRow(icon("share", 16), "Drafts & sent")}`;
  return `<nav class="sm-side">${title}${top}${section(
    "Channels",
    channels
      .filter((c) => !c.is_im)
      .map(row)
      .join(""),
  )}${section(
    "Direct messages",
    channels
      .filter((c) => c.is_im)
      .map(row)
      .join(""),
  )}${section("Apps", bot ? inertRow(face(bot, "sm-row-av"), displayName(bot)) : "")}</nav>`;
}

/** The window's title bar: history arrows, the search field, the theme switch. */
function titlebar(store: Store, opts: RenderOptions): string {
  const next = themeOf(opts) === "dark" ? "light" : "dark";
  const btn = (name: string, cls = "") =>
    `<span class="sm-tb-btn${cls}" aria-hidden="true">${icon(name, 18)}</span>`;
  return `<div class="sm-titlebar"><div class="sm-tb-left">${btn("arrowLeft")}${btn("arrowRight", " sm-tb-off")}${btn("clock")}</div><div class="sm-search" aria-hidden="true">${icon("search", 16)}<span>Search ${escapeHtml(store.team.name)}</span></div><div class="sm-tb-right"><a class="sm-tb-btn sm-theme-toggle" href="${query(opts, { theme: next }) || "?"}" title="Switch to the ${next} theme" aria-label="Switch to the ${next} theme">${icon(next === "dark" ? "moon" : "sun", 18)}</a>${btn("help")}</div></div>`;
}

/** The tab rail: workspace icon, Slack's tabs, and at the bottom who the composers post as. */
function rail(store: Store, opts: RenderOptions): string {
  const tabs = [
    ["home", "Home"],
    ["dms", "DMs"],
    ["bell", "Activity"],
    ["more", "More"],
  ]
    .map(
      ([name, label], i) =>
        `<span class="sm-tab${i ? "" : " sm-tab-on"}" aria-hidden="true"><span class="sm-tab-ic">${icon(name!)}</span>${label}</span>`,
    )
    .join("");
  return `<div class="sm-rail"><a class="sm-team-icon" href="${homeHref(opts)}" title="${escapeHtml(store.team.name)}">${escapeHtml(initials(store.team.name))}</a>${tabs}<div class="sm-rail-end"><span class="sm-rail-add" aria-hidden="true">${icon("plus")}</span>${identityChip(store, opts)}</div></div>`;
}

interface ShellParts {
  title: string;
  header: string;
  main: string;
  /** Channel id to highlight in the sidebar. */
  active?: string;
  /** Thread side panel markup. */
  panel?: string;
  /** Composer pinned under the channel column. */
  footer?: string;
  /** Inline script appended to the body (never in screenshot mode). */
  script?: string;
}

function shell(store: Store, opts: RenderOptions, parts: ShellParts): string {
  const refresh =
    opts.refreshSec && !opts.screenshot
      ? `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.refreshSec))}">`
      : "";
  const style = opts.screenshot ? "" : ` style="--sm-panel-w:${panelWidth(opts)}"`;
  // A screenshot page inlines the font: a one-shot capture must not race a font request.
  const fontBase = opts.screenshot ? undefined : opts.fontBase;
  const head = `<!doctype html><html lang="en" data-theme="${themeOf(opts)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(parts.title)}</title>${refresh}${fontBase ? fontPreloads(fontBase) : ""}<style>${stylesheet(fontBase)}</style></head>`;
  if (opts.screenshot) {
    return `${head}<body><div class="sm-shot">${parts.header}<div class="sm-page">${parts.main}</div></div></body></html>`;
  }
  const app = `sm-app${parts.panel ? " sm-app-thread" : ""}`;
  const handle = parts.panel
    ? `<div class="sm-resize" title="Drag to resize, double-click to reset"></div>`
    : "";
  return `${head}<body${style}><div class="${app}">${mobileBar(store, opts, parts.active)}${titlebar(store, opts)}<div class="sm-body">${rail(store, opts)}<div class="sm-workspace">${sidebar(store, opts, parts.active)}<div class="sm-main">${parts.header}<div class="sm-page sm-scroll">${parts.main}</div>${parts.footer ?? ""}</div>${handle}${parts.panel ?? ""}</div></div></div>${parts.script ?? ""}</body></html>`;
}

interface BackLink {
  href: string;
  label: string;
}

function topbar(title: string, sub: string, back?: BackLink, actions?: string): string {
  const backLink = back
    ? `<a class="sm-back" href="${back.href}">${escapeHtml(back.label)}</a>`
    : "";
  const right = actions ? `<div class="sm-top-actions">${actions}</div>` : "";
  return `<div class="sm-top">${backLink}<h1>${title}</h1>${sub ? `<div class="sm-sub">${sub}</div>` : ""}${right}</div>`;
}

// -------------------------------------------------------------------- views

function indexView(store: Store, opts: RenderOptions): string {
  const cards = [
    ["Workspace", escapeHtml(store.team.name)],
    ["Team id", escapeHtml(store.team.id)],
    ["Bot user", escapeHtml(`${store.app.name} (${store.bot.userId})`)],
    ["Connections", String(opts.connections ?? 0)],
  ]
    .map(
      ([k, v]) =>
        `<div class="sm-card"><div class="sm-card-k">${k}</div><div class="sm-card-v">${v}</div></div>`,
    )
    .join("");

  const channels = [...store.channels.values()];
  const channelRows = channels
    .map((c) => {
      const count = store.messages.get(c.id)?.length ?? 0;
      return `<tr><td data-label="Name"><a href="${channelHref(c.id, opts)}">${escapeHtml(channelIcon(c))} ${escapeHtml(c.is_im ? channelLabel(store, c) : c.name)}</a></td><td data-label="Type"><span class="sm-tag">${channelKind(c)}</span></td><td class="sm-muted" data-label="Id">${c.id}</td><td data-label="Messages">${count}</td></tr>`;
    })
    .join("");

  const userRows = [...store.users.values()]
    .map(
      (u) =>
        `<tr><td data-label="Name">${escapeHtml(u.name)}${userStatus(u)}</td><td data-label="Real name">${escapeHtml(u.real_name)}</td><td class="sm-muted" data-label="Title">${escapeHtml(u.profile.title ?? "")}</td><td class="sm-muted" data-label="Email">${escapeHtml(u.profile.email ?? "")}</td><td class="sm-muted" data-label="Id">${u.id}</td><td data-label="Type">${u.is_bot ? `<span class="sm-tag">bot</span>` : ""}</td></tr>`,
    )
    .join("");

  const main = `<div class="sm-admin"><div class="sm-cards">${cards}</div>
<div class="sm-h2">Channels</div>
${
  channels.length
    ? `<table class="sm-table"><tr><th>Name</th><th>Type</th><th>Id</th><th>Messages</th></tr>${channelRows}</table>`
    : `<div class="sm-empty">No channels yet</div>`
}
<div class="sm-h2">Users</div>
<table class="sm-table"><tr><th>Name</th><th>Real name</th><th>Title</th><th>Email</th><th>Id</th><th></th></tr>${userRows}</table></div>`;

  return shell(store, opts, {
    title: `${store.team.name} · slack-mock`,
    header: topbar(escapeHtml(store.team.name), "slack-mock workspace"),
    main,
    script: opts.screenshot ? "" : uiScript(store, opts, undefined, false),
  });
}

/** Top-level messages plus this channel's ephemerals, in ts order. */
function channelMessages(store: Store, channel: SlackChannel) {
  const history = store.history(channel.id, { limit: 1000 }).items;
  const ephemerals = store.ephemerals
    .filter((e) => e.channel === channel.id)
    .map((e) => ({ ...e, _ephemeral: true }));
  return [...history, ...ephemerals].sort((a, b) => Number(a.ts) - Number(b.ts));
}

function channelColumn(
  store: Store,
  ctx: RenderContext,
  opts: RenderOptions,
  channel: SlackChannel,
  openTs?: string,
): string {
  const messages = channelMessages(store, channel);
  if (!messages.length) return `<div class="sm-empty">No messages yet</div>`;
  return renderMessageList(store, ctx, messages, opts, {
    threadLink: true,
    dividers: true,
    openTs,
  });
}

/** `# general ⌄`, the topic, then the member stack, the huddle button and the tab row. */
function channelHeader(store: Store, opts: RenderOptions, channel: SlackChannel): string {
  const sub = [channel.topic.value, channel.purpose.value].filter(Boolean).join(" · ");
  const peer = channel.is_im && channel.user ? store.users.get(channel.user) : undefined;
  const glyph = peer ? face(peer) : icon(channel.is_private ? "lock" : "hash", 18);
  const name = channel.is_im ? channelLabel(store, channel) : channel.name;
  const title = `${glyph}<span>${escapeHtml(name)}</span>`;
  if (opts.screenshot) return topbar(title, escapeHtml(sub));
  const members = channel.members.flatMap((id) => store.users.get(id) ?? []);
  const stack = members
    .slice(0, 3)
    .map((u) => face(u))
    .join("");
  const actions = `<span class="sm-top-pill" aria-hidden="true"><span class="sm-faces">${stack}</span>${members.length}</span><span class="sm-top-pill" aria-hidden="true">${icon("headphones", 16)}${icon("chevronDown", 12)}</span><span class="sm-top-ic" aria-hidden="true">${icon("moreVertical", 18)}</span>`;
  const tabs = `<div class="sm-tabs" aria-hidden="true"><span class="sm-tabs-on">${icon("thread", 14)}Messages</span><span>${icon("canvas", 14)}Add canvas</span><span>${icon("plus", 14)}</span></div>`;
  return `${topbar(
    `${title}<span class="sm-caret">${icon("chevronDown", 14)}</span>`,
    escapeHtml(sub),
    { href: homeHref(opts), label: "← Workspace" },
    actions,
  )}${tabs}`;
}

// ---------------------------------------------------------------- composer

/** Human users, bots excluded: the composer posts as one of them. */
function humanUsers(store: Store): SlackUser[] {
  return [...store.users.values()].filter((u) => !u.is_bot && !u.deleted);
}

function userStatus(user: SlackUser): string {
  return user.profile.status_text
    ? `<span class="sm-user-status">${escapeHtml(user.profile.status_text)}</span>`
    : "";
}

function identityChip(store: Store, opts: RenderOptions): string {
  if (opts.screenshot) return "";
  const users = humanUsers(store);
  const selected = users[0];
  if (!selected) return "";
  const name = selected.real_name || selected.name;
  const avatar = face(selected, "sm-identity-avatar");
  const items = users
    .map((u) => {
      const real = u.real_name || u.name;
      return `<li><button type="button" data-user="${escapeHtml(u.id)}">${face(u, "sm-identity-avatar")}<span>${escapeHtml(real)}${userStatus(u)}</span><span class="sm-identity-user">@${escapeHtml(u.name)}</span></button></li>`;
    })
    .join("");
  const hidden = opts.writeGated ? " hidden" : "";
  return `<details class="sm-identity"${hidden}><summary title="Change posting identity" aria-label="Posting as ${escapeHtml(name)}">${avatar}<span class="sm-identity-name">${escapeHtml(name)}</span></summary><ul class="sm-identity-list">${items}</ul></details>`;
}

function composer(
  store: Store,
  opts: RenderOptions,
  channel: SlackChannel,
  threadTs?: string,
): string {
  if (opts.screenshot) return "";
  const users = humanUsers(store);
  if (!users.length) return "";
  const placeholder = threadTs ? "Reply in thread" : `Message ${channelLabel(store, channel)}`;
  const thread = threadTs ? ` data-thread="${escapeHtml(threadTs)}"` : "";
  const gated = opts.writeGated ? ' data-gated="1"' : "";
  const lock = opts.writeGated
    ? `<div class="sm-composer-lock" hidden><span>Reading is open. Sign in to post.</span><input class="sm-lock-user" placeholder="user" autocomplete="username"><input class="sm-lock-pass" type="password" placeholder="password" autocomplete="current-password"><button type="button" class="sm-lock-go">Sign in</button><span class="sm-err"></span></div>`
    : "";
  // Slack's formatting bar and attachment tools are drawn for the picture only; the text box,
  // the send button and @mentions work.
  const tools = (names: string[]) =>
    names.map((name) => (name ? `<span>${icon(name, 18)}</span>` : "<i></i>")).join("");
  const format = `<div class="sm-composer-fmt" aria-hidden="true">${tools(["bold", "italic", "strike", "", "link", "", "listOrdered", "listBullet", "", "quote", "", "code", "codeBlock"])}</div>`;
  const also = threadTs
    ? `<div class="sm-composer-also" aria-hidden="true"><i></i>Also send to ${escapeHtml(channelLabel(store, channel))}</div>`
    : "";
  const row = `<div class="sm-composer-row"><span class="sm-composer-tools" aria-hidden="true"><span class="sm-tool-plus">${icon("plus", 18)}</span>${tools(["format", "smile", "at", "", "video", "mic", "", "slash"])}</span><button type="button" class="sm-composer-send" aria-label="Send now" title="Send now">${icon("send", 16)}</button><span class="sm-composer-send-more" aria-hidden="true">${icon("chevronDown", 14)}</span></div>`;
  return `<div class="sm-composer" data-channel="${escapeHtml(channel.id)}"${thread}${gated}><div class="sm-mentions"></div><div class="sm-composer-box">${format}<textarea class="sm-composer-text" rows="1" placeholder="${escapeHtml(placeholder)}" data-placeholder="${escapeHtml(placeholder)}"></textarea>${also}${row}</div>${lock}<div class="sm-composer-hint">Enter to send, Shift+Enter for a new line, @name to mention<span class="sm-lock-state"></span></div></div>`;
}

/** Mention targets for the composer autocomplete: every user, bots included. */
function mentionData(store: Store): string {
  const users = [...store.users.values()]
    .filter((u) => !u.deleted)
    .map((u) => ({
      id: u.id,
      name: u.name,
      real: u.real_name || u.name,
      initials: initials(u.real_name || u.name),
      color: avatarColor(u.id),
      image: userImage(u),
      bot: u.is_bot,
    }));
  const json = JSON.stringify(users).replace(/</g, "\\u003c");
  return `<script type="application/json" id="sm-users">${json}</script>`;
}

/**
 * The whole client side: scroll to the newest message, drag the panel edge,
 * send from the composers, mention autocomplete and Escape to close a thread.
 */
function uiScript(store: Store, opts: RenderOptions, closeUrl?: string, autoScroll = true): string {
  const esc = closeUrl
    ? `document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!/^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement&&document.activeElement.tagName||""))location.href=${JSON.stringify(closeUrl)}});`
    : "";
  const body = `(function(){
var viewport=window.visualViewport;
function fitViewport(){if(viewport&&viewport.scale!==1)return;var style=document.documentElement.style;style.setProperty("--sm-viewport-height",(viewport?viewport.height:innerHeight)+"px");style.setProperty("--sm-viewport-top",(viewport?viewport.offsetTop:0)+"px")}
fitViewport();addEventListener("resize",fitViewport);
if(viewport){viewport.addEventListener("resize",fitViewport);viewport.addEventListener("scroll",fitViewport)}
document.addEventListener("change",function(e){if(e.target.classList.contains("sm-channel-switch"))location.href=e.target.value});
document.addEventListener("click",function(e){var b=e.target.closest(".sm-pager-btn");if(!b)return;var block=b.closest(".sm-table-block"),pages=block.querySelectorAll("tbody"),cur=0;pages.forEach(function(t,i){if(!t.hidden)cur=i});var next=Math.min(Math.max(cur+Number(b.dataset.step),0),pages.length-1);pages.forEach(function(t,i){t.hidden=i!==next});block.querySelector(".sm-pager-label").textContent=pages[next].dataset.range;var btns=block.querySelectorAll(".sm-pager-btn");btns[0].disabled=next===0;btns[1].disabled=next===pages.length-1});
var W="sm-panel-w",DEF=${JSON.stringify(panelWidth(opts))},FIXED=${opts.panelWidth ? "true" : "false"};
${autoScroll ? 'function scroll(){document.querySelectorAll(".sm-scroll").forEach(function(el){el.scrollTop=el.scrollHeight})}\nscroll();addEventListener("load",scroll);' : ""}
var handle=document.querySelector(".sm-resize");
if(handle){
 var saved=null;try{saved=localStorage.getItem(W)}catch(e){}
 if(!FIXED&&saved)document.body.style.setProperty("--sm-panel-w",saved);
 var dragging=false;
 handle.addEventListener("mousedown",function(e){dragging=true;handle.classList.add("sm-dragging");e.preventDefault()});
 document.addEventListener("mousemove",function(e){if(!dragging)return;var w=Math.round(Math.min(Math.max(innerWidth-e.clientX,360),Math.max(innerWidth-320,360)));document.body.style.setProperty("--sm-panel-w",w+"px")});
 document.addEventListener("mouseup",function(){if(!dragging)return;dragging=false;handle.classList.remove("sm-dragging");try{localStorage.setItem(W,document.body.style.getPropertyValue("--sm-panel-w"))}catch(e){}});
 handle.addEventListener("dblclick",function(){try{localStorage.removeItem(W)}catch(e){}document.body.style.setProperty("--sm-panel-w",DEF)});
}
var raw=document.getElementById("sm-users");
var USERS=raw?JSON.parse(raw.textContent||"[]"):[],HUMANS=USERS.filter(function(u){return !u.bot});
var PEOPLE=USERS.concat([{name:"here",real:"Notify everyone online",initials:"@",color:"#616061"},{name:"channel",real:"Notify everyone in the channel",initials:"@",color:"#616061"}]);
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":"&quot;"})}
function paintAvatar(el,u){if(u.image){el.innerHTML='<img src="'+esc(u.image)+'" alt="">';el.style.backgroundColor=""}else{el.textContent=u.initials;el.style.backgroundColor=u.color}}
var GATED=${opts.writeGated ? "true" : "false"},LIVE=${opts.live !== false && !opts.refreshSec ? "true" : "false"},CK="sm-presenter",IK="sm-identity",currentIdentity="",identityStorage=true;
function cred(){try{return localStorage.getItem(CK)||""}catch(e){return ""}}
function setCred(v){try{if(v)localStorage.setItem(CK,v);else localStorage.removeItem(CK)}catch(e){}}
function setIdentity(v){currentIdentity=v;try{if(v)localStorage.setItem(IK,v);else localStorage.removeItem(IK)}catch(e){identityStorage=false}}
function findIdentity(value,key){for(var i=0;i<HUMANS.length;i++)if(HUMANS[i][key]===value)return HUMANS[i];return null}
function identity(){var id=currentIdentity;if(identityStorage)try{id=localStorage.getItem(IK)||currentIdentity}catch(e){identityStorage=false}currentIdentity=id;var u=findIdentity(id,"id");if(!u&&HUMANS.length){u=HUMANS[0];setIdentity(u.id)}return u}
(function(){var url=null,name=null;try{url=new URL(location.href);name=url.searchParams.get("as")}catch(e){}if(url&&name!==null){var u=findIdentity(name,"name");if(u)setIdentity(u.id);url.searchParams.delete("as");var search=url.searchParams.toString();history.replaceState(null,"",url.pathname+(search?"?"+search:"")+url.hash)}})();
(function(){var m=/[#&]presenter=([^&]+)/.exec(location.hash||"");if(m){setCred(btoa(decodeURIComponent(m[1])));history.replaceState(null,"",location.pathname+location.search)}})();
function authHeaders(h){var c=cred();if(c)h.authorization="Basic "+c;return h}
var reactionDialog=document.querySelector(".sm-reaction-picker"),reactionTarget=null,reactionScope=null,reactionBusy=false;
function closeReactions(restoreFocus){var button=reactionTarget&&reactionTarget.querySelector(".sm-add-reaction");if(reactionDialog&&reactionDialog.open)reactionDialog.close();reactionTarget=null;reactionScope=null;if(restoreFocus&&button&&button.isConnected&&!button.disabled)button.focus({preventScroll:true})}
function findMessageElement(scope,ts){var found=null;if(scope)scope.querySelectorAll(".sm-msg[data-ts]").forEach(function(message){if(message.dataset.ts===ts)found=message});return found}
function positionReactions(){
 if(!reactionDialog||!reactionDialog.open||!reactionTarget)return;
 if(!reactionTarget.isConnected){reactionTarget=findMessageElement(reactionScope,reactionTarget.dataset.ts);if(!reactionTarget){closeReactions();return}}
 var button=reactionTarget.querySelector(".sm-add-reaction"),anchor=button.getBoundingClientRect(),v=window.visualViewport,left=v?v.offsetLeft:0,top=v?v.offsetTop:0,width=v?v.width:innerWidth,height=v?v.height:innerHeight,scope=reactionScope.getBoundingClientRect(),pad=12,gap=8;
 if(anchor.bottom<=Math.max(top,scope.top)||anchor.top>=Math.min(top+height,scope.bottom)){closeReactions();return}
 reactionDialog.style.maxWidth=Math.max(0,width-pad*2)+"px";reactionDialog.style.maxHeight=Math.max(0,height-pad*2)+"px";
 var rect=reactionDialog.getBoundingClientRect(),x=Math.max(left+pad,Math.min(anchor.right-rect.width,left+width-rect.width-pad)),y=anchor.bottom+gap;
 if(y+rect.height>top+height-pad)y=anchor.top-rect.height-gap;
 reactionDialog.style.left=x+"px";reactionDialog.style.top=Math.max(top+pad,Math.min(y,top+height-rect.height-pad))+"px";
}
document.addEventListener("scroll",function(e){if(!reactionDialog.contains(e.target))positionReactions()},true);
addEventListener("resize",positionReactions);
if(window.visualViewport){window.visualViewport.addEventListener("resize",positionReactions);window.visualViewport.addEventListener("scroll",positionReactions)}
document.addEventListener("pointerdown",function(e){if(reactionDialog.open&&!reactionDialog.contains(e.target)&&!e.target.closest(".sm-add-reaction"))closeReactions()});
document.addEventListener("focusin",function(e){if(reactionDialog.open&&!reactionDialog.contains(e.target)&&(!reactionTarget||e.target!==reactionTarget.querySelector(".sm-add-reaction")))closeReactions()});
function hasReaction(button,user){return JSON.parse(button.dataset.users||"[]").indexOf(user)!==-1}
function reactionUi(root){var u=identity(),locked=(GATED&&!cred())||!u;(root||document).querySelectorAll(".sm-add-reaction,.sm-quick,.sm-reaction[data-reaction],.sm-reaction-choices button").forEach(function(button){button.disabled=locked||reactionBusy;if(button.classList.contains("sm-reaction")){var mine=Boolean(u&&hasReaction(button,u.id)),count=button.querySelector(".sm-reaction-count").textContent;button.setAttribute("aria-pressed",String(mine));button.setAttribute("aria-label",(mine?"Remove":"Add")+" :"+button.dataset.reaction+": reaction, "+count+" "+(count==="1"?"person":"people")+" reacted")}});if(locked)closeReactions()}
function identityUi(){var u=identity();document.querySelectorAll(".sm-identity").forEach(function(chip){chip.hidden=GATED&&!cred();if(!u)return;var av=chip.querySelector("summary .sm-identity-avatar"),name=chip.querySelector(".sm-identity-name"),summary=chip.querySelector("summary");if(av)paintAvatar(av,u);if(name)name.textContent=u.real;if(summary)summary.setAttribute("aria-label","Posting as "+u.real);chip.querySelectorAll("[data-user]").forEach(function(button){if(button.dataset.user===u.id)button.setAttribute("aria-current","true");else button.removeAttribute("aria-current")})});reactionUi()}
function lockUi(){document.querySelectorAll(".sm-composer").forEach(function(box){var locked=GATED&&!cred(),lock=box.querySelector(".sm-composer-lock"),ta=box.querySelector(".sm-composer-text"),btn=box.querySelector(".sm-composer-send"),state=box.querySelector(".sm-lock-state");if(lock)lock.hidden=!locked;ta.disabled=locked;btn.disabled=locked;ta.placeholder=locked?"Sign in to post":(ta.dataset.placeholder||"");if(state)state.innerHTML=GATED&&!locked?' · signed in · <a href="#" class="sm-lock-out">Sign out</a>':""});identityUi()}
function signIn(box){if(!box)return;var u=box.querySelector(".sm-lock-user").value.trim(),p=box.querySelector(".sm-lock-pass").value,err=box.querySelector(".sm-err");if(!u){err.textContent="Enter the presenter user";return}var c=btoa(u+":"+p);err.textContent="";fetch("/mock/presenter",{headers:{authorization:"Basic "+c}}).then(function(r){if(!r.ok)throw new Error(r.status===401||r.status===403?"Wrong user or password":"Sign-in failed ("+r.status+")");setCred(c);lockUi();box.querySelector(".sm-composer-text").focus()}).catch(function(e){err.textContent=e.message})}
document.addEventListener("click",function(e){var pick=e.target.closest(".sm-identity-list button");if(pick){setIdentity(pick.dataset.user);identityUi();pick.closest(".sm-identity").open=false;return}if(!e.target.closest(".sm-identity"))document.querySelectorAll(".sm-identity[open]").forEach(function(chip){chip.open=false});var out=e.target.closest(".sm-lock-out");if(out){e.preventDefault();setCred("");lockUi();return}var go=e.target.closest(".sm-lock-go");if(go)signIn(go.closest(".sm-composer"))});
document.addEventListener("keydown",function(e){if(e.key!=="Escape")return;var chip=document.querySelector(".sm-identity[open]");if(!chip)return;e.preventDefault();e.stopImmediatePropagation();chip.open=false;chip.querySelector("summary").focus()});
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&reactionDialog&&reactionDialog.open){e.preventDefault();e.stopImmediatePropagation();closeReactions(true)}});
document.addEventListener("keydown",function(e){var c=e.target.classList;if(e.key==="Enter"&&c&&(c.contains("sm-lock-pass")||c.contains("sm-lock-user"))){e.preventDefault();signIn(e.target.closest(".sm-composer"))}});
addEventListener("storage",function(e){if(e.key===IK){currentIdentity=e.newValue||"";identityUi()}});
lockUi();
var pending=null;
function refresh(){if(pending)return;pending=setTimeout(function(){pending=null;fetch(location.href,{headers:{accept:"text/html"},credentials:"same-origin"}).then(function(r){return r.ok?r.text():Promise.reject(r.status)}).then(apply).catch(function(){reactionUi()})},120)}
function apply(html){
 var doc=new DOMParser().parseFromString(html,"text/html"),opener=document.activeElement,focusedMessage=opener&&opener.classList.contains("sm-add-reaction")?opener.closest(".sm-msg"):null,focusedScope=focusedMessage&&focusedMessage.closest(".sm-page,.sm-panel-body");
 reactionUi();reactionUi(doc);[".sm-side",".sm-channel-switch",".sm-page",".sm-panel-body"].forEach(function(sel){var cur=document.querySelector(sel),nxt=doc.querySelector(sel);if(!cur||!nxt)return;var seen={};cur.querySelectorAll(".sm-msg[data-ts]").forEach(function(el){el.classList.remove("sm-msg-new","sm-msg-changed");seen[el.dataset.ts]=el.outerHTML});var atBottom=cur.scrollHeight-cur.scrollTop-cur.clientHeight<80;cur.innerHTML=nxt.innerHTML;cur.querySelectorAll(".sm-msg[data-ts]").forEach(function(el){var prev=seen[el.dataset.ts];if(prev===undefined)el.classList.add("sm-msg-new");else if(prev!==el.outerHTML)el.classList.add("sm-msg-changed")});if(atBottom)cur.scrollTop=cur.scrollHeight});identityUi();positionReactions();if(doc.title)document.title=doc.title;
 if(focusedMessage&&!opener.isConnected){var message=findMessageElement(focusedScope,focusedMessage.dataset.ts);if(message)message.querySelector(".sm-add-reaction").focus({preventScroll:true})}
}
if(LIVE&&window.EventSource){
 var box0=document.querySelector(".sm-composer"),pm=/^\\/c\\/([^/]+)/.exec(location.pathname),chan=box0?box0.dataset.channel:(pm?decodeURIComponent(pm[1]):null);
 if(chan){
  var h1=document.querySelector(".sm-top h1"),dot=null;
  if(h1){dot=document.createElement("span");dot.className="sm-live";h1.appendChild(dot)}
  var es=new EventSource("/c/"+encodeURIComponent(chan)+"/events"),down=false;
  es.addEventListener("change",refresh);
  es.onopen=function(){if(dot){dot.textContent="";dot.classList.remove("sm-live-off")}if(down){down=false;refresh()}};
  es.onerror=function(){down=true;if(dot){dot.textContent="Reconnecting";dot.classList.add("sm-live-off")}};
 }
}
function react(message,name){
 var u=identity();if(!message||!u||reactionBusy||(GATED&&!cred()))return;
 var action="add";message.querySelectorAll(".sm-reaction[data-reaction]").forEach(function(button){if(button.dataset.reaction===name&&hasReaction(button,u.id))action="remove"});
 var err=(reactionDialog&&reactionDialog.open?reactionDialog:message).querySelector(".sm-action-error");if(err){err.hidden=true;err.textContent=""}
 reactionBusy=true;reactionUi();
 fetch("/mock/reactions",{method:"POST",headers:authHeaders({"content-type":"application/json"}),body:JSON.stringify({channel:message.dataset.channel,ts:message.dataset.ts,name:name,user:u.id,action:action})}).then(function(r){
  if(r.status===401||r.status===403){setCred("");lockUi();throw new Error("Sign in to react.")}
  return r.json().then(function(data){if(!r.ok&&data.error!=="already_reacted"&&data.error!=="no_reaction")throw new Error("Could not save the reaction. Try again.")})
 }).then(function(){reactionBusy=false;reactionUi();closeReactions(true);refresh()}).catch(function(e){reactionBusy=false;reactionUi();if(err){if(err.closest("dialog")&&!reactionDialog.open)err=message.querySelector(".sm-action-error");err.textContent=e.message==="Sign in to react."?e.message:"Could not save the reaction. Try again.";err.hidden=false;positionReactions()}})
}
document.addEventListener("click",function(e){
 var add=e.target.closest(".sm-add-reaction");if(add&&!add.disabled){var message=add.closest(".sm-msg");if(reactionDialog.open&&reactionTarget===message){closeReactions(true);return}reactionTarget=message;reactionScope=message.closest(".sm-page,.sm-panel-body");var err=reactionDialog.querySelector(".sm-action-error");err.hidden=true;err.textContent="";if(!reactionDialog.open)reactionDialog.show();positionReactions();return}
 var choice=e.target.closest("button[data-reaction]");if(choice&&!choice.disabled){react(choice.closest(".sm-reaction-picker")?reactionTarget:choice.closest(".sm-msg"),choice.dataset.reaction);return}
 if(e.target.closest(".sm-reaction-close")){closeReactions(true);return}
 var reply=e.target.closest(".sm-reply-action"),box=document.querySelector(".sm-composer[data-thread]");if(reply&&box&&box.dataset.thread===reply.dataset.thread&&box.dataset.channel===reply.closest(".sm-msg").dataset.channel)e.preventDefault()
});
function send(box){var t=box.querySelector(".sm-composer-text"),text=t.value.trim(),user=identity();if(!text||t.disabled||!user)return;var body={channel:box.dataset.channel,user:user.id,text:text};if(box.dataset.thread)body.thread_ts=box.dataset.thread;t.disabled=true;fetch("/mock/messages",{method:"POST",headers:authHeaders({"content-type":"application/json"}),body:JSON.stringify(body)}).then(function(r){t.disabled=false;if(r.status===401||r.status===403){setCred("");lockUi();var err=box.querySelector(".sm-err");if(err)err.textContent="Not signed in, or the credential changed. Sign in to post.";return}if(!r.ok)throw new Error("send failed "+r.status);t.value="";if(LIVE)refresh();else location.reload()}).catch(function(){t.disabled=false})}
document.querySelectorAll(".sm-composer").forEach(function(box){
 var ta=box.querySelector(".sm-composer-text"),menu=box.querySelector(".sm-mentions"),items=[],active=0;
 function close(){items=[];menu.style.display="none"}
 function prefix(){var m=/(?:^|\\s)@(\\w*)$/.exec(ta.value.slice(0,ta.selectionStart));return m?m[1]:null}
 function paint(){menu.querySelectorAll(".sm-mention").forEach(function(el,i){el.className="sm-mention"+(i===active?" sm-mention-on":"")})}
 function show(){
  var q=prefix();if(q===null)return close();
  var low=q.toLowerCase();
  var list=PEOPLE.filter(function(u){return !low||u.name.toLowerCase().indexOf(low)===0||u.real.toLowerCase().indexOf(low)===0}).slice(0,8);
  if(!list.length)return close();
  items=list;active=0;
  menu.innerHTML=list.map(function(u,i){return '<div class="sm-mention'+(i?"":" sm-mention-on")+'" data-i="'+i+'"><span class="sm-mention-av"'+(u.image?'><img src="'+esc(u.image)+'" alt="">':' style="background:'+esc(u.color)+'">'+esc(u.initials))+'</span><span class="sm-mention-name">@'+esc(u.name)+'</span><span class="sm-mention-real">'+esc(u.real)+'</span></div>'}).join("");
  menu.style.display="block";
 }
 function pick(i){var u=items[i];if(!u)return;var pos=ta.selectionStart,before=ta.value.slice(0,pos).replace(/@\\w*$/,"@"+u.name+" "),after=ta.value.slice(pos);ta.value=before+after;ta.selectionStart=ta.selectionEnd=before.length;close();ta.focus()}
 ta.addEventListener("input",show);
 ta.addEventListener("blur",function(){setTimeout(close,150)});
 menu.addEventListener("mousedown",function(e){var el=e.target.closest(".sm-mention");if(el){e.preventDefault();pick(Number(el.dataset.i))}});
 ta.addEventListener("keydown",function(e){
  if(e.key==="Backspace"&&ta.selectionStart===ta.selectionEnd&&ta.selectionStart>0){
   var pos=ta.selectionStart,before=ta.value.slice(0,pos),hit="";
   for(var k=0;k<PEOPLE.length;k++){var tok="@"+PEOPLE[k].name;var cand=before.endsWith(tok)?tok:"";if(cand&&cand.length>hit.length){var at=before.length-cand.length;if(at===0||/s/.test(before.charAt(at-1)))hit=cand}}
   if(hit){e.preventDefault();ta.value=before.slice(0,before.length-hit.length)+ta.value.slice(pos);ta.selectionStart=ta.selectionEnd=pos-hit.length;close();return}
  }
  if(items.length){
   if(e.key==="ArrowDown"){e.preventDefault();active=(active+1)%items.length;paint();return}
   if(e.key==="ArrowUp"){e.preventDefault();active=(active-1+items.length)%items.length;paint();return}
   if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();pick(active);return}
   if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();return}
  }
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send(box)}
 });
 box.querySelector(".sm-composer-send").addEventListener("click",function(){send(box)});
});
})();`;
  return `${mentionData(store)}${reactionPicker()}<script>${body}${esc}</script>`;
}

function channelView(store: Store, opts: RenderOptions, channelId: string): string {
  const channel = store.channels.get(channelId);
  const ctx = ctxOf(store);
  if (!channel) return notFound(store, opts, "Channel not found");
  const label = channelLabel(store, channel);
  return shell(store, opts, {
    title: `${label} · slack-mock`,
    header: channelHeader(store, opts, channel),
    main: channelColumn(store, ctx, opts, channel),
    active: channel.id,
    footer: composer(store, opts, channel),
    script: opts.screenshot ? "" : uiScript(store, opts),
  });
}

function assistantPanel(store: Store, channelId: string, ts: string): string {
  const thread = store.assistantThreads.get(`${channelId}:${ts}`);
  if (!thread) return "";
  const parts: string[] = [];
  if (thread.title)
    parts.push(`<div class="sm-assist-title">${plainTextToHtml(thread.title)}</div>`);
  if (thread.status)
    parts.push(
      `<div class="sm-assist-status">${plainTextToHtml(thread.status)}<span class="sm-stream">•••</span></div>`,
    );
  const prompts = Array.isArray(thread.prompts) ? thread.prompts : [];
  if (prompts.length) {
    const chips = prompts
      .map((p) => {
        const prompt = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
        const title = typeof prompt.title === "string" ? prompt.title : "";
        const message = typeof prompt.message === "string" ? prompt.message : "";
        return `<span class="sm-prompt" title="${escapeHtml(message)}">${plainTextToHtml(title || message)}</span>`;
      })
      .join("");
    const heading = thread.promptsTitle
      ? `<div class="sm-assist-status">${plainTextToHtml(thread.promptsTitle)}</div>`
      : "";
    parts.push(`${heading}<div class="sm-prompts">${chips}</div>`);
  }
  if (!parts.length) return "";
  return `<div class="sm-assist">${parts.join("")}</div>`;
}

function threadView(store: Store, opts: RenderOptions, channelId: string, ts: string): string {
  const channel = store.channels.get(channelId);
  const ctx = ctxOf(store);
  if (!channel) return notFound(store, opts, "Channel not found");
  const parent = store.findMessage(channel.id, ts);
  if (!parent) return notFound(store, opts, "Message not found");

  const items = store.replies(channel.id, ts, { limit: 1000 }).items;
  const replies = items.slice(1);
  const label = channelLabel(store, channel);
  const repliesBar = replies.length
    ? `<div class="sm-replies-div"><span>${replies.length} ${replies.length === 1 ? "reply" : "replies"}</span></div>`
    : `<div class="sm-empty">No replies yet</div>`;

  const body = `${assistantPanel(store, channel.id, ts)}${renderMessage(store, ctx, parent, opts)}${repliesBar}${renderMessageList(store, ctx, replies, opts, { dividers: false })}`;

  // Screenshot mode stays thread-only so captures have no surrounding chrome.
  if (opts.screenshot) {
    const header = topbar(
      `Thread <span class="sm-muted">·</span> <a href="${channelHref(channel.id, opts)}">${escapeHtml(label)}</a>`,
      "",
    );
    return shell(store, opts, {
      title: `Thread · ${label}`,
      header,
      main: body,
      active: channel.id,
    });
  }

  const close = channelHref(channel.id, opts);
  const title = `Thread · ${label}`;

  if (opts.threadView === "full") {
    const header = topbar(
      `Thread <span class="sm-muted">·</span> ${escapeHtml(label)}`,
      "",
      { href: close, label: `← ${label}` },
      `<a class="sm-icon-btn" href="${threadHref(channel.id, ts, opts, { full: false })}" title="Collapse to panel" aria-label="Collapse to panel">⤡</a>`,
    );
    return shell(store, opts, {
      title,
      header,
      main: body,
      active: channel.id,
      footer: composer(store, opts, channel, ts),
      script: uiScript(store, opts, close),
    });
  }

  const expand = threadHref(channel.id, ts, opts, { full: true });
  const panel = `<aside class="sm-panel"><div class="sm-panel-top"><a class="sm-panel-back" href="${close}" aria-label="Back to ${escapeHtml(label)}">←</a><div class="sm-panel-heading"><h2 class="sm-panel-title">Thread</h2><div class="sm-panel-sub">${escapeHtml(label)}</div></div><a class="sm-panel-expand" href="${expand}" title="Expand thread">⤢</a><a class="sm-panel-close" href="${close}" title="Close thread">×</a></div><div class="sm-panel-body sm-scroll">${body}</div>${composer(store, opts, channel, ts)}</aside>`;
  return shell(store, opts, {
    title,
    header: channelHeader(store, opts, channel),
    main: channelColumn(store, ctx, opts, channel, ts),
    active: channel.id,
    panel,
    footer: composer(store, opts, channel),
    script: uiScript(store, opts, close),
  });
}

function notFound(store: Store, opts: RenderOptions, message: string): string {
  return shell(store, opts, {
    title: message,
    header: topbar(escapeHtml(message), ""),
    main: `<div class="sm-empty">${escapeHtml(message)}</div>`,
  });
}

export function renderPage(store: Store, view: View, opts: RenderOptions = {}): string {
  switch (view.kind) {
    case "channel":
      return channelView(store, opts, view.channel);
    case "thread":
      return threadView(store, opts, view.channel, view.ts);
    default:
      return indexView(store, opts);
  }
}
