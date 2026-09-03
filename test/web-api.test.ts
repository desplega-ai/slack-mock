import { afterAll, beforeAll, expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import { SlackMock } from "../src/index.ts";
import { appFor, errorCode, rejected } from "./helpers.ts";

let mock: SlackMock;
let app: App;
const messageEvents: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
  app = appFor(mock);
  app.event("message", async ({ event, say }) => {
    const message = event as unknown as Record<string, unknown>;
    messageEvents.push(message);
    if (message.text === "thread me")
      await say({ text: "threaded", thread_ts: message.ts as string });
  });
  await app.start();
  await mock.waitForConnection();
});

afterAll(async () => {
  await app.stop();
  await mock.stop();
});

test("messages, history, replies, and metadata follow Slack semantics", async () => {
  const parent = await mock.postMessage({ channel: "general", user: "alice", text: "thread me" });
  const reply = await mock.waitForMessage({
    channel: "C0GENERAL0",
    thread_ts: parent.ts,
    from: "bot",
  });
  const metadata = await app.client.chat.postMessage({
    channel: "C0GENERAL0",
    text: "metadata",
    metadata: { event_type: "test.event", event_payload: { source: "test" } },
  });
  await app.client.chat.update({ channel: "C0GENERAL0", ts: reply.ts, text: "updated" });
  await app.client.chat.delete({ channel: "C0GENERAL0", ts: reply.ts });
  await mock.flush();

  const replies = await app.client.conversations.replies({ channel: "C0GENERAL0", ts: parent.ts });
  expect(replies.messages?.map((message) => message.ts)).toEqual([parent.ts]);
  const metadataWithoutFlag = await app.client.conversations.replies({
    channel: "C0GENERAL0",
    ts: metadata.ts!,
  });
  expect(metadataWithoutFlag.messages?.[0]?.metadata).toBeUndefined();
  const withMetadata = await app.client.conversations.replies({
    channel: "C0GENERAL0",
    ts: metadata.ts!,
    include_all_metadata: true,
  });
  expect(withMetadata.messages?.[0]?.metadata?.event_type).toBe("test.event");
  const history = await app.client.conversations.history({ channel: "C0GENERAL0" });
  expect(history.messages?.some((message) => message.thread_ts === parent.ts)).toBeFalse();
  expect(messageEvents.some((event) => event.subtype === "message_changed")).toBeTrue();
  expect(messageEvents.some((event) => event.subtype === "message_deleted")).toBeTrue();
});

test("channels, users, reactions, and permalinks return Slack errors", async () => {
  const message = await app.client.chat.postMessage({ channel: "C0GENERAL0", text: "react to me" });
  await app.client.reactions.add({ channel: "C0GENERAL0", timestamp: message.ts!, name: "wave" });
  expect(
    errorCode(
      await rejected(
        app.client.reactions.add({ channel: "C0GENERAL0", timestamp: message.ts!, name: "wave" }),
      ),
    ),
  ).toBe("already_reacted");
  expect(
    errorCode(
      await rejected(
        app.client.reactions.remove({
          channel: "C0GENERAL0",
          timestamp: message.ts!,
          name: "eyes",
        }),
      ),
    ),
  ).toBe("no_reaction");

  const absent = mock.addChannel({ name: "without-bot", withBot: false });
  expect(
    errorCode(await rejected(app.client.chat.postMessage({ channel: absent.id, text: "blocked" }))),
  ).toBe("not_in_channel");
  await app.client.conversations.join({ channel: absent.id });
  await expect(
    app.client.chat.postMessage({ channel: absent.id, text: "allowed" }),
  ).resolves.toBeDefined();

  const user = await app.client.users.info({ user: "U0ALICE000" });
  expect(user.user?.name).toBe("alice");
  expect((await app.client.users.lookupByEmail({ email: "alice@example.com" })).user?.id).toBe(
    "U0ALICE000",
  );
  expect(
    errorCode(await rejected(app.client.users.lookupByEmail({ email: "missing@example.com" }))),
  ).toBe("users_not_found");

  const created = await app.client.conversations.create({ name: "new-channel" });
  expect(errorCode(await rejected(app.client.conversations.create({ name: "new-channel" })))).toBe(
    "name_taken",
  );
  await app.client.conversations.invite({ channel: created.channel!.id!, users: "U0ALICE000" });
  expect(
    errorCode(
      await rejected(
        app.client.conversations.invite({ channel: created.channel!.id!, users: "U0ALICE000" }),
      ),
    ),
  ).toBe("already_in_channel");
  await app.client.conversations.archive({ channel: created.channel!.id! });
  expect(
    errorCode(
      await rejected(
        app.client.chat.postMessage({ channel: created.channel!.id!, text: "closed" }),
      ),
    ),
  ).toBe("is_archived");

  const permalink = await app.client.chat.getPermalink({
    channel: "C0GENERAL0",
    message_ts: message.ts!,
  });
  expect(permalink.permalink).toContain(`/archives/C0GENERAL0/p${message.ts!.replace(".", "")}`);
  await app.client.chat.delete({ channel: "C0GENERAL0", ts: message.ts! });
  expect(
    errorCode(
      await rejected(
        app.client.chat.getPermalink({ channel: "C0GENERAL0", message_ts: message.ts! }),
      ),
    ),
  ).toBe("message_not_found");
});

test("pagination, ephemerals, and API call records are observable", async () => {
  mock.addChannel({ name: "page-one" });
  mock.addChannel({ name: "page-two" });
  let cursor: string | undefined;
  const names: string[] = [];
  do {
    const page = await app.client.conversations.list({ limit: 1, cursor });
    names.push(...(page.channels ?? []).map((channel) => channel.name!));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  expect(names).toEqual(expect.arrayContaining(["general", "page-one", "page-two"]));

  await app.client.chat.postEphemeral({
    channel: "C0GENERAL0",
    user: "U0ALICE000",
    text: "private",
  });
  expect(
    mock.ephemeralMessages("general").some((message) => message.text === "private"),
  ).toBeTrue();
  expect(
    (await app.client.conversations.history({ channel: "C0GENERAL0" })).messages?.some(
      (m) => m.text === "private",
    ),
  ).toBeFalse();

  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "block" } }];
  const parent = await app.client.chat.postMessage({ channel: "C0GENERAL0", text: "API parent" });
  await app.client.chat.postMessage({
    channel: "C0GENERAL0",
    text: "record me",
    thread_ts: parent.ts!,
    blocks,
  });
  const call = mock.apiCalls("chat.postMessage").at(-1)!;
  expect(call.args.thread_ts).toBe(parent.ts);
  expect(call.args.blocks).toEqual(blocks);
});
