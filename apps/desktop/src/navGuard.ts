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
}

export function createNavGuardRegistry(): NavGuardRegistry {
  let current: (() => boolean) | null = null;
  return {
    register: (guard) => {
      current = guard;
    },
    unregister: (guard) => {
      if (current === guard) current = null;
    },
    confirm: () => current?.() !== false,
    guarded: () => current !== null,
  };
}

/** Context carrying the registry from App down to whichever screen needs to register. */
export const NavGuardContext = createContext<NavGuardRegistry | null>(null);

export function useNavGuardRegistry(): NavGuardRegistry | null {
  return useContext(NavGuardContext);
}
