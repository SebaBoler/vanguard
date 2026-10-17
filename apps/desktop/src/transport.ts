// Transport seam between the Inspector UI and its backend. Two backends answer the same calls:
// Tauri's `invoke`/`listen` (the desktop app, and the branch vitest + dev/mockBackend.ts exercise)
// and the hub's `POST /rpc/<cmd>` + `/events` SSE stream (a browser against `vanguard hub`, no Tauri
// runtime present). Mode resolution order: the server-injected `window.__VANGUARD_HUB__` marker
// (src/hub/static.ts), then `VITE_VANGUARD_HUB=1` (lets `pnpm dev` point at a running hub), else Tauri.
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

declare global {
  interface Window {
    __VANGUARD_HUB__?: boolean;
  }
}

export function isHubMode(): boolean {
  if (window.__VANGUARD_HUB__ === true) return true;
  return import.meta.env.VITE_VANGUARD_HUB === '1';
}

// Fleet spawns shell commands — remote code execution on a reachable server — so hub mode disables
// it everywhere (src/hub/rpc.ts's DISABLED_COMMANDS rejects the underlying calls too).
export function canUseFleet(): boolean {
  return !isHubMode();
}

async function hubInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/rpc/${cmd}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });
  } catch (err) {
    // Network failure (server unreachable, CORS, etc.) — reject with a string, like Tauri's Err(String).
    throw err instanceof Error ? err.message : String(err);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw err instanceof Error ? err.message : String(err);
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw typeof message === 'string' ? message : `request to ${cmd} failed with status ${response.status}`;
  }
  return (body as { result: T }).result;
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isHubMode() ? hubInvoke<T>(cmd, args) : tauriInvoke<T>(cmd, args);
}

/** One lazily created `EventSource('/events')` shared by every `subscribe()` call, routed by event
 * name. Module-level so every caller — regardless of which component mounted first — shares it. */
let hubSource: EventSource | undefined;
interface HubSubscription {
  listener: (ev: MessageEvent) => void;
  handlers: Set<(event: { payload: unknown }) => void>;
}
const hubSubscriptions = new Map<string, HubSubscription>();

function parsePayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function hubSubscribe<T>(name: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  hubSource ??= new EventSource('/events');
  let sub = hubSubscriptions.get(name);
  if (!sub) {
    const handlers = new Set<(event: { payload: unknown }) => void>();
    const listener = (ev: MessageEvent): void => {
      const event = { payload: parsePayload(ev.data) };
      for (const h of handlers) h(event);
    };
    sub = { listener, handlers };
    hubSubscriptions.set(name, sub);
    hubSource.addEventListener(name, listener);
  }
  sub.handlers.add(handler as (event: { payload: unknown }) => void);

  const unlisten: UnlistenFn = () => {
    sub!.handlers.delete(handler as (event: { payload: unknown }) => void);
    if (sub!.handlers.size === 0) {
      hubSource?.removeEventListener(name, sub!.listener);
      hubSubscriptions.delete(name);
    }
    if (hubSubscriptions.size === 0 && hubSource) {
      hubSource.close();
      hubSource = undefined;
    }
  };
  return Promise.resolve(unlisten);
}

export function subscribe<T>(name: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  return isHubMode() ? hubSubscribe<T>(name, handler) : tauriListen<T>(name, handler);
}
