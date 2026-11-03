import { createHmac } from "node:crypto";
import {
  type AckResult,
  type DeliveryRecord,
  type EnvelopeType,
  envelopeName,
} from "./socket-mode.ts";

export interface HttpDeliveryOptions {
  /** Events API "Request URL". Receives `events_api` payloads as signed JSON. */
  eventsUrl: string;
  /** Interactivity "Request URL" (block_actions, view_submission). Default: `eventsUrl`. */
  interactivityUrl?: string;
  /** Slash command "Request URL". Default: `eventsUrl`. */
  commandsUrl?: string;
  /** The app's signing secret. Every request is signed with it, like Slack. */
  signingSecret: string;
  /** Wait before each Events API redelivery (Slack: about 1 minute, 5 minutes, 30 minutes). */
  retryDelaysMs?: number[];
  /** How long to wait for the HTTP response before counting a timeout (Slack: 3s). */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`, the `X-Slack-Signature` value. */
export function slackSignature(secret: string, timestamp: string | number, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

export class HttpDeliveryError extends Error {}

/** Thrown by a delivery cut short by `shutdown()`; the mock treats it as a clean stop. */
export class HttpDeliveryStoppedError extends HttpDeliveryError {
  constructor() {
    super("mock stopped");
  }
}

type Attempt = { ok: true; payload?: unknown } | { ok: false; reason: string };

/**
 * The HTTP side of the mock: the same deliveries as Socket Mode, posted to the
 * app's request URLs and signed with its signing secret. Events API requests are
 * redelivered with `X-Slack-Retry-Num` / `X-Slack-Retry-Reason` when the app does
 * not answer 2xx in time; slash commands and interactivity are posted once, as
 * Slack does, and the response body is the ack payload.
 */
export class HttpDelivery {
  /** Every request sent, in order, with its ack status. */
  readonly history: DeliveryRecord[] = [];
  readonly opts: Required<Omit<HttpDeliveryOptions, "log" | "interactivityUrl" | "commandsUrl">> & {
    interactivityUrl: string;
    commandsUrl: string;
    log: (msg: string) => void;
  };

  private readonly stopController = new AbortController();
  private retryTimers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();

  constructor(opts: HttpDeliveryOptions) {
    this.opts = {
      eventsUrl: opts.eventsUrl,
      interactivityUrl: opts.interactivityUrl ?? opts.eventsUrl,
      commandsUrl: opts.commandsUrl ?? opts.eventsUrl,
      signingSecret: opts.signingSecret,
      retryDelaysMs: opts.retryDelaysMs ?? [60_000, 300_000, 1_800_000],
      timeoutMs: opts.timeoutMs ?? 3_000,
      log: opts.log ?? (() => {}),
    };
  }

  /**
   * Cancel everything pending: abort in-flight requests, wake every retry wait so its
   * `send` rejects with `HttpDeliveryStoppedError`, and refuse new requests.
   */
  shutdown(): void {
    this.stopController.abort();
    for (const t of this.retryTimers) {
      clearTimeout(t.timer);
      t.wake();
    }
    this.retryTimers.clear();
  }

  private get stopped(): boolean {
    return this.stopController.signal.aborted;
  }

  /** Wait `ms` before a redelivery; `shutdown()` ends the wait early. */
  private waitToRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          this.retryTimers.delete(entry);
          resolve();
        }, ms),
        wake: resolve,
      };
      this.retryTimers.add(entry);
    });
  }

  /** An HTTP app is always "connected": nothing to wait for. */
  get connectionCount(): number {
    return 1;
  }

  waitForConnection(): Promise<void> {
    return Promise.resolve();
  }

  /** Slack's URL verification: POST a `url_verification` challenge and expect it echoed back. */
  async verifyUrl(): Promise<boolean> {
    const challenge = crypto.randomUUID();
    const body = JSON.stringify({
      token: "mock-verification-token",
      challenge,
      type: "url_verification",
    });
    const res = await this.post(this.opts.eventsUrl, body, "application/json", {});
    if (!res.ok) return false;
    return (
      (res.payload as { challenge?: string } | undefined)?.challenge === challenge ||
      res.text === challenge
    );
  }

  async send(
    type: EnvelopeType,
    payload: unknown,
    _acceptsResponsePayload = false,
  ): Promise<AckResult> {
    if (this.stopped) throw new HttpDeliveryStoppedError();
    const record: DeliveryRecord = {
      envelope_id: crypto.randomUUID(),
      type,
      name: envelopeName(type, payload),
      sentAt: new Date().toISOString(),
      attempts: 0,
      acked: false,
    };
    this.history.push(record);
    const { url, body, contentType } = this.encode(type, payload);
    const delays = type === "events_api" ? this.opts.retryDelaysMs : [];
    let retry: { num: number; reason: string } | undefined;
    for (let attempt = 0; ; attempt++) {
      record.attempts = attempt + 1;
      const res = await this.post(url, body, contentType, retry ? this.retryHeaders(retry) : {});
      if (this.stopped) throw new HttpDeliveryStoppedError();
      if (res.ok) {
        record.acked = true;
        record.ackPayload = res.payload;
        return { envelope_id: record.envelope_id, payload: res.payload, attempts: record.attempts };
      }
      const delay = delays[attempt];
      if (delay === undefined) {
        throw new HttpDeliveryError(
          `${record.name} not acknowledged (${res.reason}) after ${record.attempts} attempt(s)`,
        );
      }
      this.opts.log(`${record.name} to ${url}: ${res.reason}; retry ${attempt + 1} in ${delay}ms`);
      await this.waitToRetry(delay);
      if (this.stopped) throw new HttpDeliveryStoppedError();
      retry = { num: attempt + 1, reason: res.reason };
    }
  }

  private retryHeaders(retry: { num: number; reason: string }): Record<string, string> {
    return { "X-Slack-Retry-Num": String(retry.num), "X-Slack-Retry-Reason": retry.reason };
  }

  /** Events go as JSON; slash commands as a form; interactivity as a form with one `payload` field. */
  private encode(
    type: EnvelopeType,
    payload: unknown,
  ): { url: string; body: string; contentType: string } {
    if (type === "events_api") {
      return {
        url: this.opts.eventsUrl,
        body: JSON.stringify(payload),
        contentType: "application/json",
      };
    }
    const form = new URLSearchParams();
    if (type === "interactive") {
      form.set("payload", JSON.stringify(payload));
    } else {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (value !== undefined && value !== null) form.set(key, String(value));
      }
    }
    return {
      url: type === "interactive" ? this.opts.interactivityUrl : this.opts.commandsUrl,
      body: form.toString(),
      contentType: "application/x-www-form-urlencoded",
    };
  }

  private async post(
    url: string,
    body: string,
    contentType: string,
    extraHeaders: Record<string, string>,
  ): Promise<Attempt & { text?: string }> {
    if (this.stopped) return { ok: false, reason: "stopped" };
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "X-Slack-Request-Timestamp": String(timestamp),
          "X-Slack-Signature": slackSignature(this.opts.signingSecret, timestamp, body),
          "User-Agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
          ...extraHeaders,
        },
        body,
        signal: AbortSignal.any([
          AbortSignal.timeout(this.opts.timeoutMs),
          this.stopController.signal,
        ]),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, reason: "http_error" };
      }
      const text = await res.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        payload = undefined;
      }
      return { ok: true, payload, text };
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return { ok: false, reason: timedOut ? "http_timeout" : "connection_failed" };
    }
  }
}
