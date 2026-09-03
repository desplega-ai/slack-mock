// Server-rendered, Slack-looking HTML for the mock workspace. No client-side
// JavaScript and no external assets, so a page can be screenshotted by headless
// Chrome or opened directly in a browser while debugging a test.

import type { Store } from "../store.ts";
import type { SlackChannel, SlackFile, SlackMessage, SlackUser } from "../types.ts";
import { renderAttachments, renderBlocks } from "./blocks.ts";
import {
  displayName,
  emojiChar,
  escapeHtml,
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
}

const DEFAULT_PANEL_WIDTH = "50%";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const AVATAR_COLORS = [
  "#4a154b",
  "#1264a3",
  "#2eb67d",
  "#e01e5a",
  "#e8912d",
  "#007a5a",
  "#7c3aed",
  "#00a2ac",
  "#df10a5",
  "#3d5afe",
];

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{font-family:Lato,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.46668;color:#1d1c1d;background:#fff;-webkit-font-smoothing:antialiased}
a{color:#1264a3;text-decoration:none}
a:hover{text-decoration:underline}
.sm-app{display:flex;height:100vh;overflow:hidden}
.sm-side{width:230px;flex:none;background:#3f0e40;color:#d9d0d9;padding:16px 0;overflow-y:auto}
.sm-side-title{color:#fff;font-weight:900;font-size:17px;padding:0 16px 12px;border-bottom:1px solid #522653;margin-bottom:10px}
.sm-side-team{display:block;font-weight:400;font-size:12px;color:#bda9bd}
.sm-side-h{font-size:13px;color:#bda9bd;padding:10px 16px 4px}
.sm-side a{display:block;color:#d9d0d9;padding:3px 16px;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-side a:hover{background:#522653;color:#fff;text-decoration:none}
.sm-side a.sm-active,.sm-side a.sm-active:hover{background:#1164a3;color:#fff}
.sm-side-title a:hover{background:none;text-decoration:underline}
.sm-main{flex:1;min-width:280px;display:flex;flex-direction:column;overflow:hidden}
.sm-shot{width:760px;padding:16px;background:#fff}
.sm-top{border-bottom:1px solid #e8e8e8;padding:12px 20px;display:flex;align-items:baseline;gap:12px;flex:none}
.sm-top h1{font-size:18px;font-weight:900;margin:0}
.sm-top .sm-sub{font-size:13px;color:#616061;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-back{font-size:13px;font-weight:700;color:#616061;flex:none}
.sm-back:hover{color:#1264a3}
.sm-page{padding:12px 20px 32px}
.sm-main .sm-page{flex:1;overflow-y:auto}
.sm-shot .sm-page{padding:0}
.sm-shot .sm-top{padding:0 0 10px;margin-bottom:8px}

.sm-panel{width:var(--sm-panel-w,50%);min-width:360px;flex:0 1 auto;display:flex;flex-direction:column;border-left:1px solid #e8e8e8;background:#fff;overflow:hidden}
.sm-panel-top{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-bottom:1px solid #e8e8e8;flex:none}
.sm-panel-heading{flex:1;min-width:0}
.sm-panel-title{font-size:18px;font-weight:900;margin:0;line-height:22px}
.sm-panel-sub{font-size:13px;color:#616061}
.sm-panel-close,.sm-panel-expand{font-size:16px;line-height:22px;color:#616061;padding:0 6px;border-radius:4px;flex:none}
.sm-panel-close{font-size:20px}
.sm-panel-close:hover,.sm-panel-expand:hover{background:#f0f0f0;color:#1d1c1d;text-decoration:none}
.sm-panel-back{display:none;padding:8px 16px;font-size:13px;font-weight:700;border-bottom:1px solid #e8e8e8;flex:none}
.sm-panel-body{flex:1;overflow-y:auto;padding:12px 16px 32px}
.sm-resize{width:6px;flex:none;cursor:col-resize;background:#f2f2f2;border-left:1px solid #e8e8e8}
.sm-resize:hover,.sm-resize.sm-dragging{background:#1264a3;border-left-color:#1264a3}
.sm-icon-btn{display:inline-block;font-size:16px;line-height:22px;color:#616061;padding:0 6px;border-radius:4px;cursor:pointer}
.sm-icon-btn:hover{background:#f0f0f0;color:#1d1c1d;text-decoration:none}
.sm-composer{position:relative;flex:none;border-top:1px solid #e8e8e8;padding:10px 20px 12px;background:#fff}
.sm-panel .sm-composer{padding:10px 16px 12px}
.sm-composer-box{border:1px solid #bbb;border-radius:8px;padding:8px 10px;background:#fff}
.sm-composer-box:focus-within{border-color:#1264a3;box-shadow:0 0 0 1px #1264a3}
.sm-composer-row{display:flex;align-items:center;gap:8px;margin-top:6px}
.sm-composer-user{flex:0 1 auto;min-width:0;max-width:170px;border:0;border-radius:4px;background:#f0f0f0;color:#1d1c1d;font-family:inherit;font-size:12px;padding:4px 6px}
.sm-composer-user:hover{background:#e8e8e8}
.sm-composer-text{display:block;width:100%;border:0;outline:none;resize:vertical;font-family:inherit;font-size:15px;line-height:20px;color:#1d1c1d;padding:0;background:none}
.sm-composer-send{flex:none;margin-left:auto;border:0;border-radius:4px;background:#007a5a;color:#fff;font-family:inherit;font-weight:700;font-size:13px;padding:6px 14px;cursor:pointer}
.sm-composer-send:hover{background:#148567;color:#fff}
.sm-composer-hint{font-size:11px;color:#616061;margin-top:4px}
.sm-mentions{display:none;position:absolute;left:20px;right:20px;bottom:100%;margin-bottom:6px;max-height:260px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.16);z-index:5}
.sm-panel .sm-mentions{left:16px;right:16px}
.sm-mention{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:14px;cursor:pointer;color:#1d1c1d}
.sm-mention-on{background:#1264a3;color:#fff}
.sm-mention-on .sm-mention-real{color:#dbe9f5}
.sm-mention-av{width:20px;height:20px;border-radius:3px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700}
.sm-mention-name{font-weight:700}
.sm-mention-real{color:#616061;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.sm-side a,.sm-btn,.sm-select,.sm-reaction,.sm-file-card,.sm-prompt,.sm-replies,.sm-back,.sm-panel-close,.sm-panel-expand,.sm-composer-send,.sm-composer-user,.sm-top-actions a{cursor:pointer}
.sm-composer-text{cursor:text}
.sm-badge,.sm-time,.sm-daydiv,.sm-pill,.sm-emoji-name,.sm-avatar,.sm-name,.sm-composer-hint,.sm-unsupported,.sm-tag,.sm-card{cursor:default}
.sm-top-actions{margin-left:auto;display:flex;gap:12px;align-items:baseline;flex:none}
.sm-top-actions a{font-size:13px;font-weight:700;color:#616061}
.sm-top-actions a:hover{color:#1264a3}
@media (max-width:900px){
  .sm-side{display:none}
  .sm-app-thread .sm-main{display:none}
  .sm-panel{width:100%;min-width:0;border-left:0}
  .sm-panel-back{display:block}
  .sm-panel-expand,.sm-resize{display:none}
}

.sm-daydiv{display:flex;align-items:center;gap:10px;margin:14px 0 8px}
.sm-daydiv:before,.sm-daydiv:after{content:"";flex:1;height:1px;background:#e8e8e8}
.sm-daydiv span{border:1px solid #e8e8e8;border-radius:12px;padding:2px 12px;font-size:13px;font-weight:700;color:#454245;background:#fff}

.sm-msg{display:flex;gap:12px;padding:8px 8px;border-radius:6px}
.sm-msg:hover{background:#f8f8f8}
.sm-msg-eph{background:#fffbe6}
.sm-msg-eph:hover{background:#fff7d1}
.sm-msg-open,.sm-msg-open:hover{background:#fff8e2;box-shadow:inset 3px 0 0 #ecb22e}
.sm-avatar{width:36px;height:36px;flex:none;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;overflow:hidden}
.sm-avatar img{width:36px;height:36px;object-fit:cover}
.sm-avatar-emoji{font-size:20px;background:#f0f0f0}
.sm-msg-body{min-width:0;flex:1}
.sm-msg-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:1px}
.sm-name{font-weight:700;font-size:15px;color:#1d1c1d}
.sm-badge{background:#e8e8e8;color:#616061;font-size:10px;font-weight:700;border-radius:2px;padding:1px 4px;letter-spacing:.4px;text-transform:uppercase}
.sm-time{font-size:12px;color:#616061}
.sm-text{font-size:15px;line-height:22px;word-wrap:break-word;overflow-wrap:anywhere}
.sm-edited{font-size:12px;color:#616061}
.sm-eph-note{font-size:12px;color:#8a6d1a;margin-top:4px}
.sm-stream{display:inline-block;margin-left:4px;color:#616061;font-weight:700;animation:sm-pulse 1s ease-in-out infinite}
@keyframes sm-pulse{0%,100%{opacity:.25}50%{opacity:1}}

.sm-pill{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
.sm-link{color:#1264a3}
.sm-emoji-name{color:#616061}
.sm-code{font-family:Monaco,Menlo,Consolas,"Courier New",monospace;font-size:12px;background:#f8f8f8;border:1px solid #ddd;border-radius:3px;padding:1px 3px;color:#e01e5a}
.sm-pre{font-family:Monaco,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:8px;margin:4px 0;white-space:pre-wrap;word-break:break-word;color:#1d1c1d}
.sm-quote{border-left:4px solid #ddd;margin:4px 0;padding:0 0 0 12px;color:#1d1c1d}
.sm-list{margin:2px 0;padding-left:22px}
.sm-list li{margin:1px 0}

.sm-blocks{margin:2px 0}
.sm-block{margin:6px 0}
.sm-header-block{font-size:18px;font-weight:900;line-height:24px}
.sm-section-split{display:flex;gap:12px;align-items:flex-start}
.sm-section-main{flex:1;min-width:0}
.sm-section-acc{flex:none}
.sm-fields{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:6px}
.sm-field{flex:1 1 40%;min-width:0;font-size:14px;line-height:20px}
.sm-field-wide{flex-basis:100%}
.sm-field-title{font-weight:700}
.sm-context{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;line-height:18px;color:#616061}
.sm-context .sm-pre,.sm-context .sm-code{font-size:11px}
.sm-context-img{width:16px;height:16px;border-radius:2px;object-fit:cover}
.sm-hr{border:0;border-top:1px solid #ddd;margin:10px 0}
.sm-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sm-btn{display:inline-block;border:1px solid #bbb;border-radius:4px;padding:6px 12px;font-size:14px;font-weight:700;color:#1d1c1d;background:#fff;line-height:16px}
.sm-btn:hover{text-decoration:none;background:#f8f8f8;color:#1d1c1d}
.sm-btn-primary{background:#007a5a;border-color:#007a5a;color:#fff}
.sm-btn-primary:hover{background:#148567;border-color:#148567;color:#fff}
.sm-btn-danger{background:#e01e5a;border-color:#e01e5a;color:#fff}
.sm-btn-danger:hover{background:#c31f4c;border-color:#c31f4c;color:#fff}
.sm-btn-confirm{margin-left:6px;opacity:.7;font-weight:400}
.sm-select{display:inline-flex;align-items:center;gap:6px;border:1px solid #bbb;border-radius:4px;padding:6px 10px;font-size:14px;color:#1d1c1d;background:#fff;line-height:16px}
.sm-select-caret{color:#616061;font-size:12px}
.sm-options{display:flex;flex-direction:column;gap:4px;font-size:14px}
.sm-acc-img{max-width:88px;max-height:88px;border-radius:4px;display:block}
.sm-img{max-width:100%;border-radius:6px;display:block;margin-top:4px}
.sm-img-title{font-size:13px;font-weight:700;color:#454245}
.sm-label{font-weight:700;font-size:14px;margin-bottom:4px}
.sm-hint{font-size:12px;color:#616061;margin-top:4px}
.sm-input{border:1px solid #bbb;border-radius:4px;padding:8px 10px;font-size:14px;min-height:36px;background:#fff}
.sm-input-multi{min-height:76px}
.sm-input-ph{color:#8d8d8e}
.sm-file-block{font-size:14px;color:#454245}
.sm-video-thumb{max-width:320px;border-radius:6px;display:block}
.sm-video-title{font-size:14px;font-weight:700;margin-top:4px}
.sm-unsupported{display:inline-block;background:#f4f4f4;border:1px solid #ddd;border-radius:4px;padding:4px 8px;font-size:12px;color:#616061;font-family:Monaco,Menlo,monospace}
.sm-rt-section{margin:2px 0}

.sm-atts{margin-top:4px}
.sm-att{border-left:4px solid #ddd;border-radius:2px;padding:2px 0 2px 12px;margin:6px 0;max-width:600px}
.sm-att-pretext{font-size:15px;line-height:22px;margin-top:4px}
.sm-att-author{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#454245}
.sm-att-author-icon{width:16px;height:16px;border-radius:2px}
.sm-att-title{font-size:15px;font-weight:700;margin:2px 0}
.sm-att-text{font-size:15px;line-height:21px}
.sm-att-img{max-width:360px;border-radius:6px;display:block;margin-top:6px}
.sm-att-thumb{max-width:80px;border-radius:4px;display:block;margin-top:6px}
.sm-att-footer{display:flex;align-items:center;gap:6px;font-size:12px;color:#616061;margin-top:6px}
.sm-att-footer-icon{width:14px;height:14px;border-radius:2px}

.sm-files{margin-top:6px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.sm-file-img{max-width:480px;max-height:420px;border-radius:8px;border:1px solid #e8e8e8;display:block}
.sm-file-card{display:flex;gap:10px;align-items:center;border:1px solid #ddd;border-radius:8px;padding:8px 12px;max-width:420px}
.sm-file-icon{font-size:20px}
.sm-file-name{font-weight:700;font-size:14px}
.sm-file-meta{font-size:12px;color:#616061}

.sm-reactions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.sm-reaction{display:inline-flex;align-items:center;gap:5px;background:#f0f0f0;border:1px solid #f0f0f0;border-radius:12px;padding:1px 8px;font-size:12px;line-height:18px;color:#454245}
.sm-reaction:hover{background:#e8f5fa;border-color:#1264a3;color:#1d1c1d}
.sm-reaction-count{font-weight:700;font-size:12px}
.sm-file-card:hover{background:#f8f8f8}

.sm-replies{display:inline-flex;align-items:center;gap:8px;margin-top:4px;font-size:13px;font-weight:700;color:#1264a3}
.sm-replies:hover{color:#0b4c81}
.sm-replies-time{font-weight:400;color:#616061}
.sm-empty{color:#616061;font-size:14px;padding:16px 0}

.sm-assist{border:1px solid #e8e8e8;border-radius:8px;padding:10px 12px;margin-bottom:10px;background:#fafafa}
.sm-assist-title{font-weight:700;font-size:14px}
.sm-assist-status{font-size:13px;color:#616061;margin-top:2px}
.sm-assist-status .sm-stream{margin-left:2px}
.sm-prompts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.sm-prompt{border:1px solid #ddd;border-radius:16px;padding:5px 12px;font-size:13px;background:#fff}

.sm-cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.sm-card{border:1px solid #e8e8e8;border-radius:8px;padding:10px 14px;min-width:150px}
.sm-card-k{font-size:12px;color:#616061;text-transform:uppercase;letter-spacing:.4px}
.sm-card-v{font-size:16px;font-weight:700;margin-top:2px}
.sm-h2{font-size:15px;font-weight:900;margin:18px 0 6px}
.sm-table{border-collapse:collapse;width:100%;max-width:900px;font-size:14px}
.sm-table th{text-align:left;font-size:12px;color:#616061;font-weight:700;text-transform:uppercase;letter-spacing:.4px;padding:4px 10px 4px 0;border-bottom:1px solid #e8e8e8}
.sm-table td{padding:6px 10px 6px 0;border-bottom:1px solid #f2f2f2;vertical-align:top}
.sm-tag{display:inline-block;background:#f0f0f0;color:#454245;border-radius:10px;padding:0 8px;font-size:11px;font-weight:700}
.sm-muted{color:#616061}
`;

function ctxOf(store: Store): RenderContext {
  return { users: store.users, channels: store.channels, botUserId: store.bot.userId };
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

/** Query string for links, carrying screenshot / refresh / panel / full. */
function query(opts: RenderOptions, over: { full?: boolean } = {}): string {
  if (opts.screenshot) return "?screenshot";
  const parts: string[] = [];
  if (opts.refreshSec) parts.push(`refresh=${opts.refreshSec}`);
  const panel = panelParam(opts);
  if (panel) parts.push(`panel=${panel}`);
  if (over.full ?? opts.threadView === "full") parts.push("full");
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
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hashIndex(s: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % buckets;
}

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/);
  const letters = words
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("");
  return (letters || name.slice(0, 2) || "?").toUpperCase();
}

function channelLabel(store: Store, c: SlackChannel): string {
  if (!c.is_im) return `#${c.name}`;
  const peer = c.user ? store.users.get(c.user) : undefined;
  return peer ? displayName(peer) : c.name;
}

function channelIcon(c: SlackChannel): string {
  if (c.is_im) return "@";
  if (c.is_private) return "🔒";
  return "#";
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

function avatarHtml(m: SlackMessage, name: string): string {
  const emojiName = m.icons?.emoji;
  if (emojiName) {
    const char = emojiChar(emojiName) ?? emojiName.replace(/:/g, "");
    return `<div class="sm-avatar sm-avatar-emoji">${escapeHtml(char)}</div>`;
  }
  const imageUrl = m.icons?.image_72 ?? m.icons?.image_48 ?? m.icons?.image_64;
  if (imageUrl && /^(https?:\/\/|\/)/.test(imageUrl)) {
    return `<div class="sm-avatar"><img src="${escapeHtml(imageUrl)}" alt=""></div>`;
  }
  const seed = m.user ?? m.bot_id ?? name;
  const color = AVATAR_COLORS[hashIndex(seed, AVATAR_COLORS.length)];
  return `<div class="sm-avatar" style="background:${color}">${escapeHtml(initials(name))}</div>`;
}

function reactionsHtml(store: Store, m: SlackMessage): string {
  if (!m.reactions?.length) return "";
  const chips = m.reactions.map((r) => {
    const who = r.users
      .map((id) => {
        const user = store.users.get(id);
        return user ? displayName(user) : id;
      })
      .join(", ");
    const char = emojiChar(r.name) ?? `:${r.name}:`;
    return `<span class="sm-reaction" title="${escapeHtml(who)}">${escapeHtml(char)}<span class="sm-reaction-count">${r.count}</span></span>`;
  });
  return `<div class="sm-reactions">${chips.join("")}</div>`;
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
    return `<div class="sm-file-card"><div class="sm-file-icon">📄</div><div><div class="sm-file-name">${label}</div><div class="sm-file-meta">${meta}</div></div></div>`;
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
  const body: string[] = [];
  if (blocks) body.push(renderBlocks(blocks, ctx));
  else if (m.text) body.push(`<div class="sm-text">${mrkdwnToHtml(m.text, ctx)}</div>`);
  if (m.edited) body.push(`<div class="sm-edited">(edited)</div>`);
  if (m.attachments?.length) body.push(renderAttachments(m.attachments, ctx));
  body.push(filesHtml(m.files, store.bot.token));
  body.push(reactionsHtml(store, m));
  if (flags.ephemeral) body.push(`<div class="sm-eph-note">Only visible to you</div>`);
  if (flags.threadLink && m.reply_count) {
    const count = `${m.reply_count} ${m.reply_count === 1 ? "reply" : "replies"}`;
    const last = m.latest_reply
      ? `<span class="sm-replies-time">Last reply ${timeOf(m.latest_reply)}</span>`
      : "";
    body.push(
      `<a class="sm-replies" href="${threadHref(m.channel, m.thread_ts ?? m.ts, opts)}">${count}${last}</a>`,
    );
  }
  const streaming =
    m.streaming_state === "in_progress"
      ? `<span class="sm-stream" title="streaming">•••</span>`
      : "";
  const open = flags.openTs && flags.openTs === m.ts ? " sm-msg-open" : "";
  return `<div class="sm-msg${flags.ephemeral ? " sm-msg-eph" : ""}${open}">${avatarHtml(m, name)}<div class="sm-msg-body"><div class="sm-msg-head"><span class="sm-name">${escapeHtml(name)}</span>${isApp ? `<span class="sm-badge">APP</span>` : ""}<span class="sm-time">${timeOf(m.ts)}</span>${streaming}</div>${body.join("")}</div></div>`;
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
  for (const m of messages) {
    const label = flags.dividers === false ? "" : dayLabel(m.ts);
    if (label && label !== day) {
      day = label;
      out.push(`<div class="sm-daydiv"><span>${escapeHtml(label)}</span></div>`);
    }
    out.push(renderMessage(store, ctx, m, opts, { ...flags, ephemeral: m._ephemeral === true }));
  }
  return out.join("");
}

// -------------------------------------------------------------------- shell

function sidebar(store: Store, opts: RenderOptions, active?: string): string {
  const channels = [...store.channels.values()].sort((a, b) =>
    channelLabel(store, a).localeCompare(channelLabel(store, b)),
  );
  const links = channels
    .map(
      (c) =>
        `<a class="${c.id === active ? "sm-active" : ""}" href="${channelHref(c.id, opts)}">${escapeHtml(channelIcon(c))} ${escapeHtml(c.is_im ? channelLabel(store, c) : c.name)}</a>`,
    )
    .join("");
  return `<nav class="sm-side"><div class="sm-side-title"><a href="${homeHref(opts)}" style="color:#fff">${escapeHtml(store.team.name)}</a><span class="sm-side-team">${escapeHtml(store.team.id)} · slack-mock</span></div><div class="sm-side-h">Channels</div>${links}</nav>`;
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
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(parts.title)}</title>${refresh}<style>${CSS}</style></head>`;
  if (opts.screenshot) {
    return `${head}<body><div class="sm-shot">${parts.header}<div class="sm-page">${parts.main}</div></div></body></html>`;
  }
  const app = `sm-app${parts.panel ? " sm-app-thread" : ""}`;
  const handle = parts.panel
    ? `<div class="sm-resize" title="Drag to resize, double-click to reset"></div>`
    : "";
  return `${head}<body${style}><div class="${app}">${sidebar(store, opts, parts.active)}<div class="sm-main">${parts.header}<div class="sm-page sm-scroll">${parts.main}</div>${parts.footer ?? ""}</div>${handle}${parts.panel ?? ""}</div>${parts.script ?? ""}</body></html>`;
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
      return `<tr><td><a href="${channelHref(c.id, opts)}">${escapeHtml(channelIcon(c))} ${escapeHtml(c.is_im ? channelLabel(store, c) : c.name)}</a></td><td><span class="sm-tag">${channelKind(c)}</span></td><td class="sm-muted">${c.id}</td><td>${count}</td></tr>`;
    })
    .join("");

  const userRows = [...store.users.values()]
    .map(
      (u) =>
        `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.real_name)}</td><td class="sm-muted">${escapeHtml(u.profile.email ?? "")}</td><td class="sm-muted">${u.id}</td><td>${u.is_bot ? `<span class="sm-tag">bot</span>` : ""}</td></tr>`,
    )
    .join("");

  const main = `<div class="sm-cards">${cards}</div>
<div class="sm-h2">Channels</div>
${
  channels.length
    ? `<table class="sm-table"><tr><th>Name</th><th>Type</th><th>Id</th><th>Messages</th></tr>${channelRows}</table>`
    : `<div class="sm-empty">No channels yet</div>`
}
<div class="sm-h2">Users</div>
<table class="sm-table"><tr><th>Name</th><th>Real name</th><th>Email</th><th>Id</th><th></th></tr>${userRows}</table>`;

  return shell(store, opts, {
    title: `${store.team.name} · slack-mock`,
    header: topbar(escapeHtml(store.team.name), "slack-mock workspace"),
    main,
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

function channelHeader(store: Store, opts: RenderOptions, channel: SlackChannel): string {
  const sub = [channel.topic.value, channel.purpose.value].filter(Boolean).join(" · ");
  const back = opts.screenshot ? undefined : { href: homeHref(opts), label: "← Workspace" };
  return topbar(escapeHtml(channelLabel(store, channel)), escapeHtml(sub), back);
}

// ---------------------------------------------------------------- composer

/** Human users, bots excluded: the composer posts as one of them. */
function humanUsers(store: Store): SlackUser[] {
  return [...store.users.values()].filter((u) => !u.is_bot && !u.deleted);
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
  const options = users
    .map(
      (u, i) =>
        `<option value="${escapeHtml(u.id)}"${i === 0 ? " selected" : ""}>${escapeHtml(u.real_name || u.name)}</option>`,
    )
    .join("");
  const placeholder = threadTs ? "Reply in thread" : `Message ${channelLabel(store, channel)}`;
  const thread = threadTs ? ` data-thread="${escapeHtml(threadTs)}"` : "";
  return `<div class="sm-composer" data-channel="${escapeHtml(channel.id)}"${thread}><div class="sm-mentions"></div><div class="sm-composer-box"><textarea class="sm-composer-text" rows="2" placeholder="${escapeHtml(placeholder)}"></textarea><div class="sm-composer-row"><select class="sm-composer-user" aria-label="Post as">${options}</select><button type="button" class="sm-composer-send">Send</button></div></div><div class="sm-composer-hint">Enter to send, Shift+Enter for a new line, @name to mention</div></div>`;
}

/** Mention targets for the composer autocomplete: every user, bots included. */
function mentionData(store: Store): string {
  const users = [...store.users.values()]
    .filter((u) => !u.deleted)
    .map((u) => ({
      name: u.name,
      real: u.real_name || u.name,
      initials: initials(u.real_name || u.name),
      color: AVATAR_COLORS[hashIndex(u.id, AVATAR_COLORS.length)],
    }));
  const json = JSON.stringify(users).replace(/</g, "\\u003c");
  return `<script type="application/json" id="sm-users">${json}</script>`;
}

/**
 * The whole client side: scroll to the newest message, drag the panel edge,
 * send from the composers, mention autocomplete and Escape to close a thread.
 */
function uiScript(store: Store, opts: RenderOptions, closeUrl?: string): string {
  const esc = closeUrl
    ? `document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!/^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement&&document.activeElement.tagName||""))location.href=${JSON.stringify(closeUrl)}});`
    : "";
  const body = `(function(){
var W="sm-panel-w",DEF=${JSON.stringify(panelWidth(opts))},FIXED=${opts.panelWidth ? "true" : "false"};
function scroll(){document.querySelectorAll(".sm-scroll").forEach(function(el){el.scrollTop=el.scrollHeight})}
scroll();addEventListener("load",scroll);
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
var PEOPLE=(raw?JSON.parse(raw.textContent||"[]"):[]).concat([{name:"here",real:"Notify everyone online",initials:"@",color:"#616061"},{name:"channel",real:"Notify everyone in the channel",initials:"@",color:"#616061"}]);
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":"&quot;"})}
function send(box){var t=box.querySelector(".sm-composer-text"),text=t.value.trim();if(!text)return;var body={channel:box.dataset.channel,user:box.querySelector(".sm-composer-user").value,text:text};if(box.dataset.thread)body.thread_ts=box.dataset.thread;t.disabled=true;fetch("/mock/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(){location.reload()}).catch(function(){t.disabled=false})}
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
  menu.innerHTML=list.map(function(u,i){return '<div class="sm-mention'+(i?"":" sm-mention-on")+'" data-i="'+i+'"><span class="sm-mention-av" style="background:'+esc(u.color)+'">'+esc(u.initials)+'</span><span class="sm-mention-name">@'+esc(u.name)+'</span><span class="sm-mention-real">'+esc(u.real)+'</span></div>'}).join("");
  menu.style.display="block";
 }
 function pick(i){var u=items[i];if(!u)return;var pos=ta.selectionStart,before=ta.value.slice(0,pos).replace(/@\\w*$/,"@"+u.name+" "),after=ta.value.slice(pos);ta.value=before+after;ta.selectionStart=ta.selectionEnd=before.length;close();ta.focus()}
 ta.addEventListener("input",show);
 ta.addEventListener("blur",function(){setTimeout(close,150)});
 menu.addEventListener("mousedown",function(e){var el=e.target.closest(".sm-mention");if(el){e.preventDefault();pick(Number(el.dataset.i))}});
 ta.addEventListener("keydown",function(e){
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
  return `${mentionData(store)}<script>${body}${esc}</script>`;
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
    ? `<div class="sm-daydiv"><span>${replies.length} ${replies.length === 1 ? "reply" : "replies"}</span></div>`
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
  const panel = `<aside class="sm-panel"><div class="sm-panel-top"><div class="sm-panel-heading"><h2 class="sm-panel-title">Thread</h2><div class="sm-panel-sub">${escapeHtml(label)}</div></div><a class="sm-panel-expand" href="${expand}" title="Expand thread">⤢</a><a class="sm-panel-close" href="${close}" title="Close thread">×</a></div><a class="sm-panel-back" href="${close}">← ${escapeHtml(label)}</a><div class="sm-panel-body sm-scroll">${body}</div>${composer(store, opts, channel, ts)}</aside>`;
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
