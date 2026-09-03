import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
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
    manifest: "/Users/taras/Documents/code/agent-swarm/slack-manifest.json",
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
