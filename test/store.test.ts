import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "@slack/bolt";
import { SlackMock, Store } from "../src/index.ts";
import { parseJournal } from "../src/store.ts";
import { appFor } from "./helpers.ts";

test("JSONL restores users, channels, messages, and reactions", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "slack-mock-")), "log.jsonl");
  const first = await SlackMock.start({ port: 0, dataFile: file, seed: false });
  first.addUser({ id: "U1", name: "person" });
  const channel = first.addChannel({ id: "C1", name: "saved", members: ["U1"] });
  const message = await first.postMessage({ channel: channel.id, user: "U1", text: "persist me" });
  await first.addReaction({ channel: channel.id, ts: message.ts, name: "wave", user: "U1" });
  await first.stop();
  const entries = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(
    entries.every((entry) => typeof entry.at === "string" && typeof entry.kind === "string"),
  ).toBeTrue();

  const restored = await SlackMock.start({ port: 0, dataFile: file, seed: false });
  expect(restored.channel("saved").id).toBe("C1");
  expect(restored.messages("saved")[0]?.text).toBe("persist me");
  expect(restored.messages("saved")[0]?.reactions).toEqual([
    { name: "wave", users: ["U1"], count: 1 },
  ]);
  await restored.stop();
});

test("a manifest configures bot identity, commands, and event subscriptions", async () => {
  const mock = await SlackMock.start({
    port: 0,
    manifest: new URL("./fixtures/agent-swarm-manifest.json", import.meta.url).pathname,
  });
  const app: App = appFor(mock);
  await app.start();
  await mock.waitForConnection();
  expect(mock.bot.userId).toBeDefined();
  expect(mock.user(mock.bot.userId).name).toBe("agent-swarm");
  await expect(mock.slashCommand({ command: "/nope" })).rejects.toThrow("manifest declares");
  const message = await mock.postMessage({
    channel: "general",
    user: "alice",
    text: "message event",
  });
  await mock.addReaction({ channel: "general", ts: message.ts, name: "wave", user: "alice" });
  await mock.flush();
  expect(mock.deliveries().some((delivery) => delivery.name === "reaction_added")).toBeFalse();
  expect(mock.deliveries().some((delivery) => delivery.name === "message")).toBeTrue();
  await app.stop();
  await mock.stop();
});

test("replaying an array of changes gives the same state as replaying the file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "slack-mock-")), "log.jsonl");
  const mock = await SlackMock.start({ port: 0, dataFile: file });
  const ask = await mock.postMessage({ channel: "general", user: "alice", text: "root" });
  const reply = await mock.postMessage({
    channel: "general",
    user: "bob",
    text: "reply",
    thread_ts: ask.ts,
  });
  await mock.addReaction({ channel: "general", ts: ask.ts, name: "eyes", user: "bob" });
  await mock.editMessage("general", reply.ts, "edited reply");
  await mock
    .postMessage({ channel: "general", user: "alice", text: "gone" })
    .then((m) => mock.deleteMessage("general", m.ts));
  await mock.stop();

  const snapshot = (store: Store) =>
    JSON.stringify({
      users: [...store.users],
      channels: [...store.channels],
      messages: [...store.messages],
      files: [...store.files],
    });
  const fromFile = new Store({ dataFile: file });
  const changes = parseJournal(readFileSync(file, "utf8")).map((e) => e.change);
  const fromArray = new Store({ replay: changes });
  expect(fromArray.messages.get("C0GENERAL0")).toHaveLength(2);
  expect(fromArray.messages.get("C0GENERAL0")?.[0]?.reply_count).toBe(1);
  expect(snapshot(fromArray)).toBe(snapshot(fromFile));
});
