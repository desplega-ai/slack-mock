import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { frames, selectFrames } from "../src/frames.ts";
import { findChrome, SlackMock } from "../src/index.ts";
import { parseJournal } from "../src/store.ts";

const CHROME = findChrome();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** An ask, an eyes reaction, a bot reply, an unrelated channel message, a reply edit, a reaction swap. */
async function writeJournal() {
  const dir = mkdtempSync(join(tmpdir(), "slack-mock-frames-"));
  const journal = join(dir, "run.jsonl");
  const mock = await SlackMock.start({ port: 0, dataFile: journal });
  const channel = mock.channel("general").id;
  const bot = mock.bot.userId;
  const ask = await mock.postMessage({ channel, user: "alice", text: `<@${bot}> ship it` });
  await mock.addReaction({ channel, ts: ask.ts, name: "eyes", user: bot });
  const reply = mock.store.addMessage({
    channel,
    user: bot,
    bot_id: mock.bot.botId,
    text: "on it",
    thread_ts: ask.ts,
  });
  await mock.postMessage({ channel, user: "bob", text: "unrelated channel chatter" });
  mock.store.updateMessage(channel, reply.ts, { text: "done: shipped" }, bot);
  mock.store.removeReaction(channel, ask.ts, "eyes", bot);
  mock.store.addReaction(channel, ask.ts, "white_check_mark", bot);
  await mock.stop();
  return { dir, journal, channel, ask };
}

const THREAD_KINDS: string[] = [
  "message.add",
  "reaction.add",
  "message.add",
  "message.update",
  "reaction.remove",
  "reaction.add",
];

test("selectFrames keeps the lines that touch the thread, in journal order", async () => {
  const { journal, channel, ask } = await writeJournal();
  const entries = parseJournal(readFileSync(journal, "utf8"));
  expect(entries.map((e) => e.change.kind).slice(0, 4)).toEqual([
    "user.add",
    "user.add",
    "user.add",
    "channel.add",
  ]);

  const thread = selectFrames(entries, channel, ask.ts);
  expect(thread.map((e): string => e.change.kind)).toEqual(THREAD_KINDS);
  expect(thread.map((e) => e.line)).toEqual([5, 6, 7, 9, 10, 11]);

  const whole = selectFrames(entries, channel);
  expect(whole.map((e) => e.line)).toEqual([5, 6, 7, 8, 9, 10, 11]);
  expect(whole[3]?.change.kind).toBe("message.add");
});

test("frames rejects an unknown channel and a thread no line touches", async () => {
  const { dir, journal } = await writeJournal();
  const out = join(dir, "frames");
  await expect(frames({ journal, channel: "nope", out })).rejects.toThrow("channel nope not found");
  await expect(frames({ journal, channel: "general", thread: "1.000000", out })).rejects.toThrow(
    "no line of",
  );
});

test.skipIf(!CHROME)(
  "frames writes one PNG per relevant line plus the final copies",
  async () => {
    const { dir, journal, ask } = await writeJournal();
    const out = join(dir, "frames");
    const result = await frames({ journal, channel: "general", thread: ask.ts, out });

    expect(result.frames.map((f) => basename(f.path))).toEqual([
      "01-message.add.png",
      "02-reaction.add.png",
      "03-message.add.png",
      "04-message.update.png",
      "05-reaction.remove.png",
      "06-reaction.add.png",
    ]);
    expect(result.frames.map((f) => f.index)).toEqual([5, 6, 7, 9, 10, 11]);
    expect(result.frames.map((f) => f.kind)).toEqual(THREAD_KINDS);
    for (const f of result.frames) expect(readFileSync(f.path).subarray(0, 4)).toEqual(PNG_MAGIC);

    expect(result.finalThread).toBe(join(out, "final-thread.png"));
    expect(readFileSync(result.finalThread)).toEqual(readFileSync(result.frames[5]!.path));
    expect(result.finalDesktop).toBe(join(out, "final-desktop.png"));
    expect(readFileSync(result.finalDesktop!).subarray(0, 4)).toEqual(PNG_MAGIC);
  },
  60_000,
);

test.skipIf(!CHROME)(
  "the CLI prints one line per frame and the final paths",
  async () => {
    const { dir, journal, channel } = await writeJournal();
    const out = join(dir, "cli-frames");
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "frames",
        "--journal",
        journal,
        "--channel",
        channel,
        "--out",
        out,
        "--no-desktop",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe(`5\tmessage.add\t${join(out, "01-message.add.png")}`);
    expect(lines[3]).toBe(`8\tmessage.add\t${join(out, "04-message.add.png")}`);
    expect(lines[7]).toBe(`final-thread=${join(out, "final-thread.png")}`);
    expect(stdout).not.toContain("final-desktop=");
  },
  60_000,
);

test("the CLI exits 1 with the error on stderr", async () => {
  const { dir, journal } = await writeJournal();
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "../src/cli.ts"),
      "frames",
      "--journal",
      journal,
      "--channel",
      "general",
      "--thread",
      "1.000000",
      "--out",
      join(dir, "never"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toContain("no line of");
});
