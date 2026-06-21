import { describe, it, expect } from 'vitest';
import { runClaudeCli } from './claude-stream.js';
import type { AgentRunInput } from './provider.js';

describe('runClaudeCli env forwarding', () => {
  it('forwards input.env to sandbox.exec', async () => {
    let seenEnv: Record<string, string> | undefined;
    const sandbox = {
      exec: async (_cmd: string, opts: { env?: Record<string, string> }) => {
        seenEnv = opts.env;
        return { stdout: '{"type":"result","result":"ok","session_id":"s"}', stderr: '', exitCode: 0 };
      },
    } as unknown as AgentRunInput['sandbox'];

    const input = {
      prompt: 'hi', sandbox, workdir: '/w', home: '/h', env: { ANTHROPIC_BASE_URL: 'http://x' },
    } as AgentRunInput;
    const gen = runClaudeCli(input, () => ['--print']);
    while (!(await gen.next()).done) { /* drain */ }
    expect(seenEnv).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
  });
});
