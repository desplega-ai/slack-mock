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

/** Like `findChrome`, but throws when no binary is found. */
export function requireChrome(): string {
  const chrome = findChrome();
  if (!chrome)
    throw new Error("no Chrome/Chromium binary found; set SLACK_MOCK_CHROME=/path/to/chrome");
  return chrome;
}

export interface ScreenshotOptions {
  out: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

/** Set the viewport before navigation because Chrome clamps narrow CLI windows to 500px. */
async function screenshotWithCdp(
  chrome: string,
  target: URL,
  opts: ScreenshotOptions,
  width: number,
  height: number,
): Promise<string> {
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30_000);
  let socket: WebSocket | undefined;
  const reader = proc.stderr.getReader();
  try {
    const decoder = new TextDecoder();
    let stderr = "";
    let endpoint: RegExpExecArray | null = null;
    while (!endpoint) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Chrome closed before opening DevTools");
      stderr += decoder.decode(value, { stream: true });
      endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
    }
    socket = new WebSocket(endpoint[1]!);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener(
        "error",
        () => reject(new Error("Cannot connect to Chrome DevTools")),
        { once: true },
      );
      socket!.addEventListener("close", () => reject(new Error("Chrome DevTools closed")), {
        once: true,
      });
    });
    let nextId = 0;
    let sessionId: string | undefined;
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
      }
    >();
    let pageLoaded = () => {};
    let loadFailed = (_error: Error) => {};
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Page.loadEventFired" && message.sessionId === sessionId) pageLoaded();
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result ?? {});
    };
    socket.onclose = socket.onerror = () => {
      const error = new Error("Chrome DevTools closed before capture completed");
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      loadFailed(error);
    };
    const command = (method: string, params: Record<string, unknown> = {}) => {
      const id = ++nextId;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket!.send(JSON.stringify({ id, method, params, sessionId }));
      });
    };
    const { targetId } = await command("Target.createTarget", { url: "about:blank" });
    const attached = await command("Target.attachToTarget", { targetId, flatten: true });
    if (typeof attached.sessionId !== "string") throw new Error("Chrome returned no page session");
    sessionId = attached.sessionId;
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const loaded = new Promise<void>((resolve, reject) => {
      pageLoaded = resolve;
      loadFailed = reject;
    });
    await Promise.all([command("Page.navigate", { url: target.toString() }), loaded]);
    await command("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
    const { data } = await command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    if (typeof data !== "string") throw new Error("Chrome returned no screenshot data");
    await Bun.write(opts.out, Buffer.from(data, "base64"));
    return opts.out;
  } finally {
    socket?.close();
    clearTimeout(timer);
    reader.releaseLock();
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
  }
}

/**
 * Render a URL to a PNG with headless Chrome. Appends `screenshot=1` so the
 * mock's pages drop their navigation chrome.
 */
export async function screenshot(url: string, opts: ScreenshotOptions): Promise<string> {
  const chrome = requireChrome();
  const target = new URL(url);
  if (!target.searchParams.has("screenshot")) target.searchParams.set("screenshot", "1");
  const width = opts.width ?? 800;
  const height = opts.height ?? 1000;
  if (width < 500) return screenshotWithCdp(chrome, target, opts, width, height);
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${width},${height}`,
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
