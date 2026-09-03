import type { ServerWebSocket } from "bun";

export interface ConnData {
  id: string;
  ticket: string;
  pingTimer?: ReturnType<typeof setInterval>;
}

export type EnvelopeType = "events_api" | "interactive" | "slash_commands";

export interface Envelope {
  envelope_id: string;
  type: EnvelopeType;
  accepts_response_payload: boolean;
  retry_attempt: number;
  retry_reason: string;
  payload: unknown;
}

export interface AckResult {
  envelope_id: string;
  /** Body the app sent with its ack, e.g. a slash-command response. */
  payload?: unknown;
  attempts: number;
}

export interface SocketModeOptions {
  appId: string;
  /** Server ping frame interval. Slack pings often; the client expects one at least every 30s. */
  pingIntervalMs?: number;
  /** How long to wait for an ack before redelivering (Slack uses ~3s). */
  ackTimeoutMs?: number;
  /** Redeliveries after the first attempt (Slack retries a few times). */
  maxRetries?: number;
  log?: (msg: string) => void;
}

interface Pending {
  envelope: Envelope;
  record: DeliveryRecord;
  resolve: (r: AckResult) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  attempts: number;
}

export class SocketModeClosedError extends Error {}

export interface DeliveryRecord {
  envelope_id: string;
  type: EnvelopeType;
  /** event.type, command name or interactive payload type. */
  name: string;
  sentAt: string;
  attempts: number;
  acked: boolean;
  ackPayload?: unknown;
}

function envelopeName(type: EnvelopeType, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (type === "events_api")
    return String((p.event as Record<string, unknown> | undefined)?.type ?? "event");
  if (type === "slash_commands") return String(p.command ?? "command");
  return String(p.type ?? "interactive");
}

/**
 * The Socket Mode side of the mock: tracks app connections, pushes envelopes,
 * waits for acks, redelivers on timeout and keeps the link alive with pings.
 */
export class SocketModeHub {
  private connections = new Map<string, ServerWebSocket<ConnData>>();
  private pending = new Map<string, Pending>();
  private connectionWaiters: Array<() => void> = [];
  private rr = 0;
  readonly tickets = new Set<string>();
  /** Every envelope ever sent, in order, with its ack status. */
  readonly history: DeliveryRecord[] = [];
  readonly opts: Required<Omit<SocketModeOptions, "log">> & { log: (msg: string) => void };

  constructor(opts: SocketModeOptions) {
    this.opts = {
      appId: opts.appId,
      pingIntervalMs: opts.pingIntervalMs ?? 10_000,
      ackTimeoutMs: opts.ackTimeoutMs ?? 3_000,
      maxRetries: opts.maxRetries ?? 3,
      log: opts.log ?? (() => {}),
    };
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  issueTicket(): string {
    const ticket = crypto.randomUUID().replace(/-/g, "");
    this.tickets.add(ticket);
    return ticket;
  }

  // ------------------------------------------------- Bun websocket handlers

  open(ws: ServerWebSocket<ConnData>): void {
    this.connections.set(ws.data.id, ws);
    this.opts.log(`socket ${ws.data.id} connected (${this.connections.size} total)`);
    ws.send(
      JSON.stringify({
        type: "hello",
        num_connections: this.connections.size,
        debug_info: {
          host: "slack-mock",
          build_number: 1,
          approximate_connection_time: 18060,
        },
        connection_info: { app_id: this.opts.appId },
      }),
    );
    ws.data.pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, this.opts.pingIntervalMs);
    for (const w of this.connectionWaiters.splice(0)) w();
  }

  message(ws: ServerWebSocket<ConnData>, raw: string | Buffer): void {
    let msg: { envelope_id?: string; payload?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this.opts.log(`socket ${ws.data.id} sent non-JSON frame`);
      return;
    }
    if (!msg.envelope_id) return;
    const p = this.pending.get(msg.envelope_id);
    if (!p) {
      this.opts.log(`ack for unknown/expired envelope ${msg.envelope_id}`);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.envelope_id);
    p.record.acked = true;
    p.record.ackPayload = msg.payload;
    p.resolve({ envelope_id: msg.envelope_id, payload: msg.payload, attempts: p.attempts });
  }

  close(ws: ServerWebSocket<ConnData>): void {
    clearInterval(ws.data.pingTimer);
    this.connections.delete(ws.data.id);
    this.opts.log(`socket ${ws.data.id} closed (${this.connections.size} left)`);
  }

  // ------------------------------------------------------------- delivery

  waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.connections.size > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter((w) => w !== done);
        reject(new Error(`no Socket Mode connection after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.connectionWaiters.push(done);
    });
  }

  /** Push an envelope to one connected app and resolve when it is acked. */
  send(type: EnvelopeType, payload: unknown, acceptsResponsePayload = false): Promise<AckResult> {
    const envelope: Envelope = {
      envelope_id: crypto.randomUUID(),
      type,
      accepts_response_payload: acceptsResponsePayload,
      retry_attempt: 0,
      retry_reason: "",
      payload,
    };
    const record: DeliveryRecord = {
      envelope_id: envelope.envelope_id,
      type,
      name: envelopeName(type, payload),
      sentAt: new Date().toISOString(),
      attempts: 0,
      acked: false,
    };
    this.history.push(record);
    return new Promise<AckResult>((resolve, reject) => {
      const p: Pending = { envelope, record, resolve, reject, attempts: 0 };
      this.pending.set(envelope.envelope_id, p);
      this.attempt(p);
    });
  }

  private attempt(p: Pending): void {
    const ws = this.pickConnection();
    if (!ws) {
      this.pending.delete(p.envelope.envelope_id);
      p.reject(new SocketModeClosedError("no Socket Mode connection; is the app running?"));
      return;
    }
    p.attempts += 1;
    p.record.attempts = p.attempts;
    const wire = { ...p.envelope };
    if (p.attempts > 1) {
      wire.retry_attempt = p.attempts - 1;
      wire.retry_reason = "timeout";
    }
    ws.send(JSON.stringify(wire));
    p.timer = setTimeout(() => {
      if (p.attempts > this.opts.maxRetries) {
        this.pending.delete(p.envelope.envelope_id);
        p.reject(
          new Error(
            `envelope ${p.envelope.envelope_id} (${p.envelope.type}) not acked after ${p.attempts} attempts`,
          ),
        );
        return;
      }
      this.opts.log(
        `no ack for ${p.envelope.envelope_id}; redelivering (attempt ${p.attempts + 1})`,
      );
      this.attempt(p);
    }, this.opts.ackTimeoutMs);
  }

  private pickConnection(): ServerWebSocket<ConnData> | undefined {
    const list = [...this.connections.values()];
    if (list.length === 0) return undefined;
    this.rr = (this.rr + 1) % list.length;
    return list[this.rr];
  }

  /** Emulate Slack asking apps to reconnect (or just drop them). */
  disconnectAll(
    reason:
      | "warning"
      | "refresh_requested"
      | "too_many_websockets"
      | "link_disabled" = "refresh_requested",
    graceMs = 200,
  ): void {
    for (const ws of this.connections.values()) {
      ws.send(JSON.stringify({ type: "disconnect", reason, debug_info: { host: "slack-mock" } }));
      setTimeout(() => ws.close(1000, reason), graceMs);
    }
  }

  shutdown(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new SocketModeClosedError("mock stopped"));
    }
    this.pending.clear();
    for (const ws of this.connections.values()) {
      clearInterval(ws.data.pingTimer);
      ws.close(1001, "server shutting down");
    }
    this.connections.clear();
  }
}
