import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const live = new Set<IsolatedSandboxProvider>();
let installed = false;

/** Track a started sandbox so a termination signal can destroy it (a `finally` block misses SIGINT/SIGTERM). */
export function trackSandbox(sandbox: IsolatedSandboxProvider): void {
  live.add(sandbox);
}

/** Stop tracking a sandbox once it has been destroyed (or intentionally handed off). */
export function untrackSandbox(sandbox: IsolatedSandboxProvider): void {
  live.delete(sandbox);
}

/** Destroy every tracked sandbox, swallowing errors. Returns how many were tracked. */
export async function destroyAllTracked(): Promise<number> {
  const sandboxes = [...live];
  live.clear();
  await Promise.all(sandboxes.map((sandbox) => sandbox.destroy().catch(() => undefined)));
  return sandboxes.length;
}

/**
 * Install one-time SIGINT/SIGTERM handlers that best-effort destroy every tracked sandbox before the
 * process exits, so Ctrl-C or a kill does not orphan containers/VMs (concurrent runs are all tracked,
 * so a single signal cleans them all). Idempotent; safe to call from every prepareContext.
 */
export function installSignalCleanup(): void {
  if (installed) return;
  installed = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void destroyAllTracked().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
}
