import { test, expect, afterEach, vi } from 'vitest';
import ipcSource from '../ipc.ts?raw';
import { clearMocks } from '@tauri-apps/api/mocks';
import { invoke } from '@tauri-apps/api/core';
import { install, HANDLED_COMMANDS } from './mockBackend';
import type { Commands } from '../wire';

afterEach(() => clearMocks());

// The real coverage guard: derive the command surface from ipc.ts (the source of truth) — NOT from
// the handler map, which would be tautological. A new call() added to ipc.ts without a matching
// fixture fails HERE, instead of silently hitting the unhandled-command warn path at runtime.
// `?raw` inlines ipc.ts as text via Vite (no fs/URL — import.meta.url is not a file:// URL in vitest).
const ipcCommands = [
  ...new Set(
    [...ipcSource.matchAll(/\b(?:call|invoke)\s*(?:<[^(]*?>)?\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ),
];

test('every command ipc.ts calls has a mock handler', () => {
  // A scan that finds nothing would make the assertion below vacuously pass — fail loudly instead.
  expect(ipcCommands.length).toBeGreaterThan(0);
  const handled = new Set(HANDLED_COMMANDS);
  const missing = ipcCommands.filter((cmd) => !handled.has(cmd));
  expect(missing, `mockBackend.ts is missing handlers for ipc.ts commands: ${missing.join(', ')}`).toEqual([]);
});

// The handler map is `satisfies`-checked against the wire catalogue, so a fixture whose shape has
// drifted from the real backend's payload cannot reach a test — tsc rejects it. Shown, not asserted:
// `pnpm build` (tsc) fails on the line below without the ts-expect-error, with exactly
//   error TS2322: Type 'number' is not assignable to type 'string'.
type Handler<K extends keyof Commands> = (args: Commands[K]['args']) => Promise<Commands[K]['result']> | Commands[K]['result'];
// @ts-expect-error — taskId is a string on the wire; a number result is a compile error, not a test failure.
const wrongResultShape: Handler<'list_runs'> = () => [{ taskId: 42, timestamp: 'ts', stages: [], totalCostUsd: 0, anyFailed: false }];
void wrongResultShape;

test('no handler falls through to the unhandled-command warn path', async () => {
  install();
  // Commands whose wire result is `void` legitimately resolve undefined now that the handler map is
  // typed against the catalogue (`null` is not a `void` result), so the warn path itself is the
  // signal — not an undefined return value.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const cmd of HANDLED_COMMANDS) {
    // eslint-disable-next-line no-await-in-loop
    await invoke(cmd);
  }
  expect(warn.mock.calls.map((args) => String(args[0])), 'mockBackend.ts warned on a command it claims to handle').toEqual([]);
  warn.mockRestore();
});
