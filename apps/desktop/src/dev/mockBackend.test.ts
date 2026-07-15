import { test, expect, afterEach } from 'vitest';
import ipcSource from '../ipc.ts?raw';
import { clearMocks } from '@tauri-apps/api/mocks';
import { invoke } from '@tauri-apps/api/core';
import { install, HANDLED_COMMANDS } from './mockBackend';

afterEach(() => clearMocks());

// The real coverage guard: derive the command surface from ipc.ts (the source of truth) — NOT from
// the handler map, which would be tautological. A new invoke() added to ipc.ts without a matching
// fixture fails HERE, instead of silently hitting the unhandled-command warn path at runtime.
// `?raw` inlines ipc.ts as text via Vite (no fs/URL — import.meta.url is not a file:// URL in vitest).
const ipcCommands = [
  ...new Set([...ipcSource.matchAll(/\binvoke\s*(?:<[^(]*?>)?\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])),
];

test('every invoke() command in ipc.ts has a mock handler', () => {
  // A scan that finds nothing would make the assertion below vacuously pass — fail loudly instead.
  expect(ipcCommands.length).toBeGreaterThan(0);
  const handled = new Set(HANDLED_COMMANDS);
  const missing = ipcCommands.filter((cmd) => !handled.has(cmd));
  expect(missing, `mockBackend.ts is missing handlers for ipc.ts commands: ${missing.join(', ')}`).toEqual([]);
});

test('no handler falls through to the unhandled-command warn path', async () => {
  install();
  for (const cmd of HANDLED_COMMANDS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await invoke(cmd);
    expect(result, `command "${cmd}" returned undefined — add a fixture in mockBackend.ts`).not.toBeUndefined();
  }
});
