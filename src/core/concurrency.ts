import { totalmem } from 'node:os';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const PER_RUN_GB = 2;

let limit = defaultLimit();
let active = 0;
const waiters: Array<() => void> = [];
const releases = new Map<IsolatedSandboxProvider, () => void>();

function defaultLimit(): number {
  const env = Number(process.env.VANGUARD_MAX_SANDBOXES);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  // Half of (host RAM / per-run budget), so concurrent sandboxes can't exhaust memory; at least 1.
  return Math.max(1, Math.floor(totalmem() / 1024 ** 3 / PER_RUN_GB / 2));
}

/** Override the max number of concurrent sandboxes (e.g. from a CLI flag). Minimum 1. */
export function setSandboxLimit(n: number): void {
  limit = Math.max(1, Math.floor(n));
}

/** Current max concurrent sandboxes. */
export function sandboxLimit(): number {
  return limit;
}

/**
 * Acquire a process-wide slot for this sandbox, blocking until one frees up, so a fan-out (or many
 * concurrent runs) can't start more sandboxes than the host can hold. A freed slot is handed directly
 * to the next waiter (no queue-jumping), so `active` never exceeds the limit.
 */
export async function acquireSandboxSlot(sandbox: IsolatedSandboxProvider): Promise<void> {
  if (active < limit) active += 1;
  else await new Promise<void>((resolve) => waiters.push(resolve));
  let released = false;
  releases.set(sandbox, () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next !== undefined) next(); // transfer the slot, active unchanged
    else active -= 1; // free the slot
  });
}

/** Release the slot held by this sandbox. Idempotent; a no-op if it never held one. */
export function releaseSandboxSlot(sandbox: IsolatedSandboxProvider): void {
  const release = releases.get(sandbox);
  if (release === undefined) return;
  releases.delete(sandbox);
  release();
}
