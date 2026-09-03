import { existsSync } from "node:fs";

const CHROME_CANDIDATES = [
  process.env.SLACK_MOCK_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** Locate a Chrome/Chromium binary for headless screenshots, or undefined. */
export function findChrome(): string | undefined {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c;
  const fromPath = Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chrome");
  return fromPath ?? undefined;
}

export interface ScreenshotOptions {
  out: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

/**
 * Render a URL to a PNG with headless Chrome. Appends `screenshot=1` so the
 * mock's pages drop their navigation chrome.
 */
export async function screenshot(url: string, opts: ScreenshotOptions): Promise<string> {
  const chrome = findChrome();
  if (!chrome)
    throw new Error("no Chrome/Chromium binary found; set SLACK_MOCK_CHROME=/path/to/chrome");
  const target = new URL(url);
  if (!target.searchParams.has("screenshot")) target.searchParams.set("screenshot", "1");
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${opts.width ?? 800},${opts.height ?? 1000}`,
      `--screenshot=${opts.out}`,
      target.toString(),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30_000);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0 || !existsSync(opts.out)) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`chrome exited with ${code}: ${err.slice(-500)}`);
  }
  return opts.out;
}
