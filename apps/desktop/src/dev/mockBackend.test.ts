import { test, expect, afterEach } from 'vitest';
import { clearMocks } from '@tauri-apps/api/mocks';
import { invoke } from '@tauri-apps/api/core';
import { install, HANDLED_COMMANDS } from './mockBackend';

afterEach(() => clearMocks());

test('every IPC command has a fixture — handler never falls through to the unhandled warn path', async () => {
  install();
  for (const cmd of HANDLED_COMMANDS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await invoke(cmd);
    expect(result, `command "${cmd}" returned undefined — add a fixture in mockBackend.ts`).not.toBeUndefined();
  }
});
