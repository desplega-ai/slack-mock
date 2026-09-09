import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applySeed, loadSeedFile } from "../scripts/seed.ts";
import { findChrome, SlackMock, screenshot } from "../src/index.ts";

const CHROME = findChrome();
const ARTIFACTS = join(import.meta.dir, "artifacts");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test.skipIf(!CHROME)(
  "captures the support thread at phone dimensions",
  async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    const mock = await SlackMock.start({
      port: 0,
      seed: false,
      teamName: "Northwind Labs",
      appName: "Agent Swarm",
    });

    try {
      applySeed(mock, loadSeedFile("seeds/agent-swarm-demo.json"));
      const channel = mock.channel("support").id;
      const request = await mock.postMessage({
        channel,
        user: "taras",
        text: "A customer cannot find the invoice export after upgrading to 2.14. Can you check the likely cause and suggest a reply?",
      });
      mock.store.addMessage({
        channel,
        user: mock.bot.userId,
        bot_id: mock.bot.botId,
        app_id: mock.store.app.id,
        text: "I checked the 2.14 notes. The export moved to Billing > Invoices, and only workspace admins can open it. Ask the customer to confirm their role, then share the direct path. If the menu is still missing, collect their workspace ID and browser details for escalation.",
        thread_ts: request.ts,
      });
      await mock.addReaction({ channel, ts: request.ts, name: "eyes", user: mock.bot.userId });

      const output = join(ARTIFACTS, "phone-support-thread.png");
      await screenshot(`${mock.baseUrl}/c/support/t/${request.ts}?as=taras&screenshot=0`, {
        out: output,
        width: 390,
        height: 844,
      });

      const png = readFileSync(output);
      expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(390);
      expect(png.readUInt32BE(20)).toBe(844);
    } finally {
      await mock.stop();
    }
  },
  60_000,
);
