import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventBus, MAX_PENDING_WRITES, MAX_REPLAY_EVENTS, MAX_SSE_CLIENTS } from './events.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  statusCode = 0;
  headers: Record<string, unknown> = {};
  ended = false;
  destroyed = false;
  nextWriteReturns = true;

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) this.headers = headers;
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.nextWriteReturns;
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk);
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function fakeReq(lastEventId?: string): IncomingMessage {
  return { headers: lastEventId !== undefined ? { 'last-event-id': lastEventId } : {} } as unknown as IncomingMessage;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EventBus', () => {
  test('T-36 a published event reaches a connected client as id:/event:/data: frames', () => {
    const bus = new EventBus();
    const res = new FakeRes();
    bus.subscribe(fakeReq(), res as unknown as ServerResponse);
    bus.publish('api:event', { runId: 'run-0', event: { type: 'run-accepted' } });
    const frame = res.chunks.join('');
    expect(frame).toContain('id: 1');
    expect(frame).toContain('event: api:event');
    expect(frame).toContain('"runId":"run-0"');
  });

  test('T-37 Last-Event-ID replays only ids greater than it', () => {
    const bus = new EventBus();
    bus.publish('api:event', { n: 1 });
    bus.publish('api:event', { n: 2 });
    bus.publish('api:event', { n: 3 });
    const res = new FakeRes();
    bus.subscribe(fakeReq('1'), res as unknown as ServerResponse);
    const frame = res.chunks.join('');
    expect(frame).not.toContain('"n":1');
    expect(frame).toContain('"n":2');
    expect(frame).toContain('"n":3');
  });

  test('T-38 an id older than the ring emits stream-reset', () => {
    const bus = new EventBus();
    for (let i = 0; i < MAX_REPLAY_EVENTS + 10; i += 1) bus.publish('api:event', { n: i });
    const res = new FakeRes();
    bus.subscribe(fakeReq('1'), res as unknown as ServerResponse);
    const frame = res.chunks.join('');
    expect(frame).toContain('event: stream-reset');
  });

  test('T-39 keepalive comment emitted on the interval', () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const res = new FakeRes();
    bus.subscribe(fakeReq(), res as unknown as ServerResponse);
    bus.startKeepalive(15_000);
    vi.advanceTimersByTime(15_000);
    expect(res.chunks.some((c) => c.includes(':ka'))).toBe(true);
    bus.close();
  });

  test('T-40 client cap returns 503 beyond MAX_SSE_CLIENTS', () => {
    const bus = new EventBus();
    const clients: FakeRes[] = [];
    for (let i = 0; i < MAX_SSE_CLIENTS; i += 1) {
      const res = new FakeRes();
      bus.subscribe(fakeReq(), res as unknown as ServerResponse);
      clients.push(res);
    }
    const overflow = new FakeRes();
    const ok = bus.subscribe(fakeReq(), overflow as unknown as ServerResponse);
    expect(ok).toBe(false);
    expect(overflow.statusCode).toBe(503);
    expect(bus.clientCount).toBe(MAX_SSE_CLIENTS);
  });

  test('T-41 a slow client exceeding the pending-write cap is destroyed and others keep receiving', () => {
    const bus = new EventBus();
    const slow = new FakeRes();
    slow.nextWriteReturns = false;
    const fast = new FakeRes();
    bus.subscribe(fakeReq(), slow as unknown as ServerResponse);
    bus.subscribe(fakeReq(), fast as unknown as ServerResponse);

    for (let i = 0; i < MAX_PENDING_WRITES + 2; i += 1) bus.publish('api:event', { n: i });

    expect(slow.destroyed).toBe(true);
    expect(bus.clientCount).toBe(1);
    const fastFrame = fast.chunks.join('');
    expect(fastFrame).toContain(`"n":${MAX_PENDING_WRITES + 1}`);
  });
});
