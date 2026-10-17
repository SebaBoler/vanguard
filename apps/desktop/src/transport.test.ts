import { test, expect, afterEach, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { invoke, isHubMode, subscribe } from './transport';

/** Minimal fake EventSource — jsdom doesn't implement one. Tracks every instance so a test can
 * assert how many were actually constructed (the "one shared EventSource" guarantee). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
  }
  removeEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(cb);
  }
  close(): void {
    this.closed = true;
  }
  emit(name: string, data: unknown): void {
    const payload = { data: JSON.stringify(data) } as MessageEvent;
    for (const cb of this.listeners.get(name) ?? []) cb(payload);
  }
}

afterEach(() => {
  clearMocks();
  delete window.__VANGUARD_HUB__;
  FakeEventSource.instances = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('T-89 mode resolution: window.__VANGUARD_HUB__ === true selects hub mode', () => {
  window.__VANGUARD_HUB__ = true;
  expect(isHubMode()).toBe(true);
});

test('T-89 mode resolution: VITE_VANGUARD_HUB=1 selects hub mode when the marker is absent', () => {
  vi.stubEnv('VITE_VANGUARD_HUB', '1');
  expect(isHubMode()).toBe(true);
});

test('T-89 mode resolution: neither signal present selects the Tauri branch', async () => {
  expect(isHubMode()).toBe(false);
  const captured: Record<string, unknown> = {};
  mockIPC((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return { ok: true };
  });
  await invoke('list_runs', { repoPath: '/repo' });
  expect(captured.cmd).toBe('list_runs');
  expect(captured.args).toEqual({ repoPath: '/repo' });
});

test('T-90 hub invoke POSTs to /rpc/<cmd> with the args object and resolves result', async () => {
  window.__VANGUARD_HUB__ = true;
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ result: { runs: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const result = await invoke('list_runs', { repoPath: '/repo' });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/rpc/list_runs');
  expect(calls[0].init.method).toBe('POST');
  expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ repoPath: '/repo' });
  expect(result).toEqual({ runs: [] });
});

test('T-91 an error body rejects with the message string', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'repoPath is required', kind: 'bad-request' } }), { status: 400 }),
    ),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBe('repoPath is required');
  expect(typeof err).toBe('string');
  expect(String(err)).toBe('repoPath is required'); // matches Tauri's Err(String) rendering
});

test('T-92 a network failure rejects with a string', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(typeof err).toBe('string');
  expect(err).toContain('Failed to fetch');
});

test('T-92b a non-JSON response also rejects with a string', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>not json</html>', { status: 200 })),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(typeof err).toBe('string');
});

test('T-93 one shared EventSource, handlers routed by event name', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const aEvents: unknown[] = [];
  const bEvents: unknown[] = [];
  const unlistenA = await subscribe<{ x: number }>('event-a', (e) => aEvents.push(e.payload));
  const unlistenB = await subscribe<{ y: number }>('event-b', (e) => bEvents.push(e.payload));

  expect(FakeEventSource.instances).toHaveLength(1); // shared, not one per subscriber
  const es = FakeEventSource.instances[0]!;
  es.emit('event-a', { x: 1 });
  es.emit('event-b', { y: 2 });
  expect(aEvents).toEqual([{ x: 1 }]);
  expect(bEvents).toEqual([{ y: 2 }]);

  unlistenA();
  unlistenB();
});

test('T-94 unsubscribe closes the source when the last handler leaves', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const unlistenA = await subscribe('event-a', () => {});
  const unlistenB = await subscribe('event-b', () => {});
  const es = FakeEventSource.instances[0]!;

  unlistenA();
  expect(es.closed).toBe(false); // event-b's handler still live

  unlistenB();
  expect(es.closed).toBe(true);
});
