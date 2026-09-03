// Workspace seed for the hosted demo: users, channels, starter history and the
// prompts the driver rotates through. Loaded from SEED_FILE by demo-server.ts and
// applied only when the journal holds no channels (first boot and after a reset).
import { readFileSync } from "node:fs";
import type { AddChannelInput, AddUserInput, SlackMock } from "../src/index.ts";

export interface SeedMessage {
  /** Channel name or id. */
  channel: string;
  /** User name or id. Omit for the bot. */
  user?: string;
  text: string;
}

export interface SeedPrompt {
  channel: string;
  user: string;
  /** May contain `<@bot>`, replaced with the bot's user id. */
  text: string;
}

export interface SeedFile {
  users?: AddUserInput[];
  channels?: Array<AddChannelInput & { withBot?: boolean }>;
  messages?: SeedMessage[];
  driver?: { prompts: SeedPrompt[] };
}

export function loadSeedFile(path: string): SeedFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SeedFile;
  if (parsed === null || typeof parsed !== "object") throw new Error(`${path}: not a JSON object`);
  return parsed;
}

/** Replace the `<@bot>` placeholder with the bot's real user id. */
export function withBotMention(text: string, botUserId: string): string {
  return text.replaceAll("<@bot>", `<@${botUserId}>`);
}

/**
 * Create the users, channels and starter messages. Users and channels that
 * already exist (by name) are reused, so applying the same seed twice is safe.
 * Returns the counts that were created.
 */
export function applySeed(
  mock: SlackMock,
  seed: SeedFile,
): { users: number; channels: number; messages: number } {
  const store = mock.store;
  const userIds = new Map<string, string>();
  for (const u of store.users.values()) userIds.set(u.name, u.id);
  let users = 0;
  for (const input of seed.users ?? []) {
    if (userIds.has(input.name)) continue;
    const created = mock.addUser(input);
    userIds.set(created.name, created.id);
    users += 1;
  }
  const resolveUser = (name: string): string => {
    const id = userIds.get(name) ?? (store.users.has(name) ? name : undefined);
    if (!id) throw new Error(`seed: unknown user "${name}"`);
    return id;
  };
  let channels = 0;
  for (const input of seed.channels ?? []) {
    if (store.channelByName(input.name)) continue;
    const members = (input.members ?? []).map(resolveUser);
    mock.addChannel({ ...input, members, creator: input.creator && resolveUser(input.creator) });
    channels += 1;
  }
  let messages = 0;
  for (const m of seed.messages ?? []) {
    const channel = store.channelByName(m.channel) ?? store.channels.get(m.channel);
    if (!channel) throw new Error(`seed: unknown channel "${m.channel}"`);
    const text = withBotMention(m.text, store.bot.userId);
    if (m.user) {
      const user = resolveUser(m.user);
      if (!channel.members.includes(user)) store.join(channel.id, user);
      store.addMessage({ channel: channel.id, user, text });
    } else {
      store.addMessage({
        channel: channel.id,
        user: store.bot.userId,
        bot_id: store.bot.botId,
        app_id: store.app.id,
        text,
      });
    }
    messages += 1;
  }
  return { users, channels, messages };
}
