// Keeps the hosted workspace alive: every `intervalMinutes` it posts the next
// prompt from the seed as a human, mentioning the bot, but only while an app is
// connected over Socket Mode so mentions never pile up unanswered.
import type { SlackMock } from "../src/index.ts";
import { type SeedPrompt, withBotMention } from "./seed.ts";

export interface DriverOptions {
  intervalMinutes: number;
  prompts: SeedPrompt[];
  log?: (msg: string) => void;
}

export function startDriver(mock: SlackMock, opts: DriverOptions): () => void {
  const log = opts.log ?? ((msg: string) => console.log(`[driver] ${msg}`));
  if (opts.intervalMinutes <= 0 || opts.prompts.length === 0) {
    log("disabled (no interval or no prompts)");
    return () => {};
  }
  let index = 0;
  const tick = async () => {
    if (mock.connectionCount === 0) {
      log("skipped: no app connected");
      return;
    }
    const prompt = opts.prompts[index % opts.prompts.length];
    index += 1;
    if (!prompt) return;
    try {
      const msg = await mock.postMessage({
        channel: prompt.channel,
        user: prompt.user,
        text: withBotMention(prompt.text, mock.bot.userId),
      });
      log(
        `posted prompt ${index}/${opts.prompts.length} to #${prompt.channel} as ${prompt.user} (ts ${msg.ts})`,
      );
    } catch (err) {
      log(`failed to post: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMinutes * 60_000);
  timer.unref?.();
  log(`every ${opts.intervalMinutes} min, ${opts.prompts.length} prompts`);
  return () => clearInterval(timer);
}
