// SSE fan-out for the hub's two server->client event channels (`api:event`, `vanguard:changed`),
// plus a bounded ring buffer for `Last-Event-ID` reconnect replay. Chosen over WebSocket (see
// docs/hub.md / tech spec §2.4): both existing `listen()` call sites in apps/desktop/src are
// server-to-client only, so a one-way stream is sufficient and `Last-Event-ID` gives backlog replay
// without hand-rolled sequence tracking.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Ring buffer size: covers several runs' reconnect window without unbounded memory growth. */
export const MAX_REPLAY_EVENTS = 500;
/** A browser left open in many tabs must not exhaust server file descriptors. */
export const MAX_SSE_CLIENTS = 16;
/** Consecutive backpressured writes before a slow client is dropped (it will reconnect and replay). */
export const MAX_PENDING_WRITES = 256;
/** Idle proxy timeouts are commonly 30-60s; keep well under that. */
export const KEEPALIVE_MS = 15_000;

interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
}

interface ClientState {
  res: ServerResponse;
  pendingWrites: number;
}

function frame(entry: BufferedEvent): string {
  return `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
}

export class EventBus {
  private nextId = 1;
  private readonly ring: BufferedEvent[] = [];
  private readonly clients = new Map<ServerResponse, ClientState>();
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  get clientCount(): number {
    return this.clients.size;
  }

  /** Publish one event to every connected client and the replay ring. */
  publish(event: string, data: unknown): void {
    const entry: BufferedEvent = { id: this.nextId++, event, data };
    this.ring.push(entry);
    if (this.ring.length > MAX_REPLAY_EVENTS) this.ring.shift();
    for (const client of this.clients.values()) this.writeEntry(client, entry);
  }

  private writeEntry(client: ClientState, entry: BufferedEvent): void {
    const flushed = this.tryWrite(client.res, frame(entry));
    if (flushed === undefined) return; // write threw; client already dropped
    if (flushed) {
      client.pendingWrites = 0;
    } else {
      client.pendingWrites += 1;
      if (client.pendingWrites > MAX_PENDING_WRITES) this.drop(client.res);
    }
  }

  /** Write, dropping the client on a thrown error. Returns `res.write`'s own return value
   * (whether the data was flushed vs. buffered due to backpressure), or undefined if it threw. */
  private tryWrite(res: ServerResponse, data: string): boolean | undefined {
    try {
      return res.write(data);
    } catch {
      this.drop(res);
      return undefined;
    }
  }

  private drop(res: ServerResponse): void {
    this.clients.delete(res);
    try {
      res.destroy();
    } catch {
      // already gone
    }
  }

  /**
   * Attach an HTTP response as an SSE client. Returns false (having already responded 503) when the
   * client cap is hit. `req`'s `Last-Event-ID` header, when present, replays buffered events newer than
   * it, or emits a single `stream-reset` frame when the gap exceeds the ring's retention.
   */
  subscribe(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.clients.size >= MAX_SSE_CLIENTS) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('too many connected event-stream clients');
      return false;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const client: ClientState = { res, pendingWrites: 0 };
    this.clients.set(res, client);

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventIdRaw = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    const lastEventId = typeof lastEventIdRaw === 'string' ? Number(lastEventIdRaw) : undefined;
    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      const oldest = this.ring[0]?.id;
      if (oldest !== undefined && lastEventId < oldest - 1) {
        if (this.tryWrite(res, 'event: stream-reset\ndata: {}\n\n') === undefined) return true;
      } else {
        for (const entry of this.ring) {
          if (entry.id > lastEventId) this.writeEntry(client, entry);
        }
      }
    }

    res.on('close', () => this.clients.delete(res));
    return true;
  }

  /** Start the keepalive comment timer (idempotent). */
  startKeepalive(intervalMs: number = KEEPALIVE_MS): void {
    if (this.keepaliveTimer !== undefined) return;
    this.keepaliveTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        this.tryWrite(client.res, ':ka\n\n');
      }
    }, intervalMs);
    this.keepaliveTimer.unref?.();
  }

  /** Dispose all connected clients and stop the keepalive timer. Idempotent. */
  close(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    for (const res of [...this.clients.keys()]) {
      try {
        res.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}
