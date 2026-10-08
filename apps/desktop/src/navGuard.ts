import { createContext, useContext } from 'react';

/**
 * App-level navigation guard (S8, issue #339). A screen holding unsaved state registers a guard;
 * every App-owned navigation (project switch, screen switch, home, remove, running-run open) runs
 * it first and aborts when the guard returns false. Needed because `<Inspector key={project}>`
 * REMOUNTS the subtree on project switch and a Rail screen-switch unmounts the editor — component-
 * local confirms never see either.
 *
 * Pure registry (no React) so the semantics are unit-testable: last registration wins (one dirty
 * screen at a time in practice), unregister is idempotent and only removes the current guard.
 */
export interface NavGuardRegistry {
  register: (guard: () => boolean) => void;
  unregister: (guard: () => boolean) => void;
  /** True ⇒ proceed with the navigation. Runs the registered guard, if any. */
  confirm: () => boolean;
  /** Whether a guard is currently registered (drives the window-close hook). */
  guarded: () => boolean;
  /**
   * Async flush hook (S10): a screen with debounced writes registers one so window close can
   * AWAIT the pending save — the synchronous confirm() cannot, and a fire-and-forget invoke
   * issued during close races webview teardown. Same last-wins/idempotent-unregister semantics
   * as the confirm guard.
   */
  registerFlush: (flush: () => Promise<void>) => void;
  unregisterFlush: (flush: () => Promise<void>) => void;
  hasFlush: () => boolean;
  /** Run the registered flush, bounded. Resolves false on failure or timeout — never rejects. */
  flush: (timeoutMs: number) => Promise<boolean>;
}

export function createNavGuardRegistry(): NavGuardRegistry {
  let current: (() => boolean) | null = null;
  let currentFlush: (() => Promise<void>) | null = null;
  return {
    register: (guard) => {
      current = guard;
    },
    unregister: (guard) => {
      if (current === guard) current = null;
    },
    confirm: () => current?.() !== false,
    guarded: () => current !== null,
    registerFlush: (flush) => {
      currentFlush = flush;
    },
    unregisterFlush: (flush) => {
      if (currentFlush === flush) currentFlush = null;
    },
    hasFlush: () => currentFlush !== null,
    flush: (timeoutMs) => {
      if (currentFlush === null) return Promise.resolve(true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        currentFlush().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ])
        .catch(() => false)
        .finally(() => clearTimeout(timer));
    },
  };
}

/** Context carrying the registry from App down to whichever screen needs to register. */
export const NavGuardContext = createContext<NavGuardRegistry | null>(null);

export function useNavGuardRegistry(): NavGuardRegistry | null {
  return useContext(NavGuardContext);
}
