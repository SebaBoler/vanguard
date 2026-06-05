import { describe, it, expect } from 'vitest';
import { encodeCwd, sessionPath, captureSession, restoreSession } from './session-store.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

describe('encodeCwd', () => {
  it('encodes cwd like the Agent SDK (non-alphanumeric -> -)', () => {
    expect(encodeCwd('/workspace')).toBe('-workspace');
    expect(encodeCwd('/Users/me/proj')).toBe('-Users-me-proj');
  });
});

describe('sessionPath', () => {
  it('builds the jsonl path under <home>/.claude/projects, honouring HOME', () => {
    expect(sessionPath('/root', '/workspace', 'abc')).toBe('/root/.claude/projects/-workspace/abc.jsonl');
    expect(sessionPath('/home/agent', '/workspace', 'abc')).toBe('/home/agent/.claude/projects/-workspace/abc.jsonl');
  });
});

describe('captureSession / restoreSession', () => {
  it('copies the jsonl out to the host dir', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyFileOut: async (s: string, h: string): Promise<void> => {
        calls.push([s, h]);
      },
    } as unknown as IsolatedSandboxProvider;
    const dest = await captureSession(sandbox, { home: '/home/agent', cwd: '/workspace', sessionId: 'sid', hostDir: '/host/sessions' });
    expect(dest).toBe('/host/sessions/sid.jsonl');
    expect(calls).toEqual([['/home/agent/.claude/projects/-workspace/sid.jsonl', '/host/sessions/sid.jsonl']]);
  });

  it('copies a captured jsonl back into the sandbox', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyIn: async (h: string, s: string): Promise<void> => {
        calls.push([h, s]);
      },
    } as unknown as IsolatedSandboxProvider;
    await restoreSession(sandbox, { home: '/root', cwd: '/workspace', sessionId: 'sid', hostFile: '/host/sessions/sid.jsonl' });
    expect(calls).toEqual([['/host/sessions/sid.jsonl', '/root/.claude/projects/-workspace/sid.jsonl']]);
  });
});
