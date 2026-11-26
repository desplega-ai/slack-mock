// Inline chips: user and app mentions, channel links, and links to known things (a GitHub PR,
// issue, commit or repo, a Linear issue, an Agent Swarm task, app, page or file).
// The look follows the Agent Swarm dashboard chips: a quiet rounded fill, an icon, a short label.

import type { SlackChannel, SlackUser } from "../types.ts";
import { icon } from "./icons.ts";
import { displayName, escapeHtml, type RenderContext } from "./mrkdwn.ts";

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

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function initials(name: string): string {
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

/** A user's profile picture when it is a URL the page may load. */
export function userImage(user: SlackUser | undefined): string | undefined {
  const url = user?.profile.image_72;
  return url && /^(https?:\/\/|\/|data:image\/)/.test(url) ? url : undefined;
}

/** Avatar contents and inline style for a user: the picture, or initials on a stable colour. */
export function userAvatar(user: SlackUser): { inner: string; style: string } {
  const image = userImage(user);
  if (image) return { inner: `<img src="${escapeHtml(image)}" alt="">`, style: "" };
  return {
    inner: escapeHtml(initials(user.real_name || user.name)),
    style: ` style="background:${avatarColor(user.id)}"`,
  };
}

/** `<@U…>`: a small avatar and the name. An id the workspace does not know stays a plain pill. */
export function userChip(user: SlackUser | undefined, fallback: string): string {
  if (!user) return `<span class="sm-pill">@${escapeHtml(fallback)}</span>`;
  const { inner, style } = userAvatar(user);
  const app = user.is_bot ? " sm-chip-app" : "";
  return `<span class="sm-pill sm-chip sm-chip-user${app}"><span class="sm-chip-av"${style}>${inner}</span>@${escapeHtml(displayName(user))}</span>`;
}

/** `<#C…>`: a link to the channel page when the workspace has it. */
export function channelChip(channel: SlackChannel | undefined, fallback: string): string {
  if (!channel) return `<span class="sm-pill">#${escapeHtml(fallback)}</span>`;
  // A literal "#" keeps the name copyable as Slack writes it; a private channel shows a lock.
  const glyph = channel.is_private ? icon("lock", 14) : "#";
  return `<a class="sm-pill sm-chip sm-chip-channel" href="/c/${encodeURIComponent(channel.id)}">${glyph}${escapeHtml(channel.name)}</a>`;
}

interface Known {
  icon: string;
  label: string;
  title: string;
  /** GitHub PR or issue: the state hint, when the workspace has one, picks the trailing icon. */
  kind?: "pull" | "issue";
}

/** Dashboard routes with an id, and the noun and icon a chip shows (the dashboard's own list). */
const ROUTES: Record<string, [noun: string, icon: string]> = {
  tasks: ["Task", "task"],
  sessions: ["Session", "thread"],
  apps: ["App", "app"],
  pages: ["Page", "globe"],
  workflows: ["Workflow", "workflow"],
  "workflow-runs": ["Workflow run", "workflow"],
  agents: ["Agent", "users"],
  schedules: ["Schedule", "clock"],
};

/** First path segments that are GitHub pages, not an owner. */
const GITHUB_PAGES = new Set([
  "about",
  "apps",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
]);

const SWARM_HOST = /(^|\.)(agent-swarm|agent-fs)\.dev$|^localhost$|^127\.0\.0\.1$/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function github(seg: string[]): Known | undefined {
  const [owner, repo, section, id] = seg;
  if (!owner || !repo || GITHUB_PAGES.has(owner.toLowerCase())) return undefined;
  const full = `${owner}/${repo}`;
  if (!section) return { icon: "github", label: full, title: full };
  if (section === "pull" && id && /^\d{1,9}$/.test(id))
    return { icon: "github", label: `${repo}#${id}`, title: `PR ${full}#${id}`, kind: "pull" };
  if (section === "issues" && id && /^\d{1,9}$/.test(id))
    return { icon: "github", label: `${repo}#${id}`, title: `Issue ${full}#${id}`, kind: "issue" };
  if (section === "commit" && id && /^[0-9a-f]{7,40}$/i.test(id))
    return { icon: "github", label: `${repo}@${id.slice(0, 7)}`, title: `${full}@${id}` };
  return undefined;
}

/** What a URL names, or undefined for any other link. */
export function knownLink(href: string): Known | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const seg = url.pathname.split("/").filter(Boolean).map(decode);
  if (host === "github.com") return github(seg);
  if (host === "linear.app") {
    const key = seg[1] === "issue" ? (seg[2] ?? "").toUpperCase() : "";
    return /^[A-Z][A-Z0-9_]{0,9}-\d{1,7}$/.test(key)
      ? { icon: "linear", label: key, title: `Linear issue ${key}` }
      : undefined;
  }
  if (!SWARM_HOST.test(host)) return undefined;
  // A drive file: /file/~/<org>/<drive>/<path>.
  if (seg[0] === "file" && seg[1] === "~" && seg.length > 4) {
    const name = seg[seg.length - 1]!;
    return { icon: url.pathname.endsWith("/") ? "folder" : "file", label: name, title: name };
  }
  const share = seg.indexOf("share");
  if (share >= 0 && seg[share + 1]) {
    const name = url.searchParams.get("name") || seg[share + 2] || "Shared file";
    return { icon: "link", label: name, title: name };
  }
  const route = ROUTES[seg[0] ?? ""];
  const id = seg[1];
  if (!route || !id || id === "new") return undefined;
  const label = `${route[0]} ${id.slice(0, 8)}`;
  return { icon: route[1], label, title: label };
}

const STATES: Record<string, [label: string, pull: string, issue: string]> = {
  open: ["Open", "pullRequest", "issue"],
  draft: ["Draft", "pullRequest", "issue"],
  merged: ["Merged", "merge", "issue"],
  closed: ["Closed", "pullRequest", "issue"],
};

/**
 * A link as a chip, or undefined when the URL names nothing known. `label` is the already
 * rendered link text; it replaces the derived text when the author wrote one.
 */
export function linkChip(href: string, label: string, ctx: RenderContext): string | undefined {
  const known = knownLink(href);
  if (!known) return undefined;
  const state = known.kind ? STATES[ctx.linkStates?.get(href) ?? ""] : undefined;
  const key = state?.[0].toLowerCase();
  const badge =
    state && known.kind
      ? `<span class="sm-chip-state sm-chip-${key}" title="${state[0]}">${icon(state[known.kind === "pull" ? 1 : 2], 14)}</span>`
      : "";
  return `<a class="sm-link sm-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(known.title)}${state ? `, ${key}` : ""}">${icon(known.icon, 14)}<span class="sm-chip-label">${label || escapeHtml(known.label)}</span>${badge}</a>`;
}
