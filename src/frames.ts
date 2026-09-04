// Render a thread (or a channel) as it looked after each journal line that touched it: one PNG
// per line. The journal is replayed in memory and each page is written to a temp file that
// headless Chrome opens over file://, so no server is started.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RenderOptions, renderPage, type View } from "./render/index.ts";
import { requireChrome, screenshot } from "./screenshot.ts";
import { loadManifest, manifestAppName, type SlackManifest } from "./server.ts";
import { type JournalEntry, parseJournal, Store } from "./store.ts";

export interface FramesOptions {
  /** Path to a JSONL journal written by `dataFile`. */
  journal: string;
  /** Channel id or name. */
  channel: string;
  /** Thread root ts. When absent, render the channel view instead of the thread view. */
  thread?: string;
  /** Output directory. Created when missing. */
  out: string;
  /** Slack app manifest path or object, same as `SlackMockOptions.manifest`. */
  manifest?: string | SlackManifest;
  /** Viewport width in px. Default 800. */
  width?: number;
  /** Viewport height in px. Default 700. */
  height?: number;
  /** Also render `final-desktop.png` (`?screenshot=0`, 1280x900). Default true. */
  desktop?: boolean;
}

export interface Frame {
  /** 1-based journal line number the frame was rendered after. */
  index: number;
  /** Journal `kind` of that line. */
  kind: string;
  /** Absolute PNG path. */
  path: string;
}

export interface FramesResult {
  frames: Frame[];
  /** Copy of the last frame. */
  finalThread: string;
  /** Present when `desktop` is true. */
  finalDesktop?: string;
}

const FRAME_KINDS = new Set([
  "message.add",
  "message.update",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "file.add",
]);

/**
 * Journal entries that change what the thread (or, without `thread`, the channel) shows.
 * `file.add` carries no message, so a file only shows up with the message that shares it.
 */
export function selectFrames(
  entries: JournalEntry[],
  channel: string,
  thread?: string,
): JournalEntry[] {
  return entries.filter(({ change }) => {
    if (!FRAME_KINDS.has(change.kind) || !("message" in change)) return false;
    const m = change.message;
    if (m.channel !== channel) return false;
    return thread ? m.ts === thread || m.thread_ts === thread : true;
  });
}

export async function frames(opts: FramesOptions): Promise<FramesResult> {
  const entries = parseJournal(readFileSync(opts.journal, "utf8"), opts.journal);
  const appName = manifestAppName(loadManifest(opts.manifest));
  const storeAfter = (line: number) =>
    new Store({ replay: entries.filter((e) => e.line <= line).map((e) => e.change), appName });
  const full = storeAfter(Number.POSITIVE_INFINITY);
  const channel = full.channels.get(opts.channel) ?? full.channelByName(opts.channel);
  if (!channel) throw new Error(`channel ${opts.channel} not found in ${opts.journal}`);
  const what = opts.thread ? `thread ${opts.thread} in ${channel.id}` : `channel ${channel.id}`;
  const selected = selectFrames(entries, channel.id, opts.thread);
  if (!selected.length) throw new Error(`no line of ${opts.journal} touches ${what}`);
  requireChrome();

  const view: View = opts.thread
    ? { kind: "thread", channel: channel.id, ts: opts.thread }
    : { kind: "channel", channel: channel.id };
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "slack-mock-frames-"));
  const html = join(tmp, "frame.html");
  const shoot = async (
    store: Store,
    file: string,
    render: RenderOptions,
    size: { width: number; height: number },
  ) => {
    writeFileSync(html, renderPage(store, view, render));
    await screenshot(Bun.pathToFileURL(html).href, { out: file, ...size });
  };
  try {
    const frames: Frame[] = [];
    const size = { width: opts.width ?? 800, height: opts.height ?? 700 };
    for (const [i, { line, change }] of selected.entries()) {
      const path = join(out, `${String(i + 1).padStart(2, "0")}-${change.kind}.png`);
      await shoot(storeAfter(line), path, { screenshot: true }, size);
      frames.push({ index: line, kind: change.kind, path });
    }
    const finalThread = join(out, "final-thread.png");
    copyFileSync(frames[frames.length - 1]!.path, finalThread);
    let finalDesktop: string | undefined;
    if (opts.desktop !== false) {
      finalDesktop = join(out, "final-desktop.png");
      await shoot(
        full,
        finalDesktop,
        { screenshot: false, live: false },
        { width: 1280, height: 900 },
      );
    }
    return { frames, finalThread, finalDesktop };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
