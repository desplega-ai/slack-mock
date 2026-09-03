// Slack-style identifiers and message timestamps.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";

export function slackId(prefix: string, length = 8): string {
  let out = prefix;
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

let lastMicros = 0;

/**
 * Slack message timestamps look like "1700000000.123456": unix seconds plus a
 * six-digit sequence. They must be unique per channel and strictly increasing,
 * so we derive them from a monotonic microsecond clock.
 */
export function nextTs(): string {
  let micros = Date.now() * 1000;
  if (micros <= lastMicros) micros = lastMicros + 1;
  lastMicros = micros;
  const seconds = Math.floor(micros / 1_000_000);
  const fraction = (micros % 1_000_000).toString().padStart(6, "0");
  return `${seconds}.${fraction}`;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
