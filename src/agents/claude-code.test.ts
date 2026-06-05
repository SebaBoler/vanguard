import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

const streamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'pracuję' }] } }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    result: 'gotowe',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
    total_cost_usd: 0.01,
  }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider): AgentRunInput {
  return { prompt: 'zrób', sandbox, workdir: '/workspace', home: '/root', effort: 'high' };
}

async function drain(sandbox: IsolatedSandboxProvider): Promise<{ turns: string[]; out: AgentRunOutput }> {
  const gen = new ClaudeCodeProvider().run(input(sandbox));
  const turns: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value.text);
  }
}

describe('ClaudeCodeProvider', () => {
  it('parses stream-json into turns and captures sessionId, usage, cost', async () => {
    const { turns, out } = await drain(fakeSandbox(streamJson));
    expect(turns).toContain('pracuję');
    expect(out.sessionId).toBe('sess-1');
    expect(out.finalText).toBe('gotowe');
    expect(out.usage?.cacheReadInputTokens).toBe(80);
    expect(out.costUsd).toBe(0.01);
  });

  it('skips non-JSON diagnostic lines', async () => {
    const { out } = await drain(fakeSandbox(`WARN something\n${streamJson}`));
    expect(out.sessionId).toBe('sess-1');
  });

  it('throws AgentError on non-zero exit', async () => {
    const gen = new ClaudeCodeProvider().run(input(fakeSandbox(streamJson, 1)));
    await expect(
      (async () => {
        for await (const turn of gen) void turn;
      })(),
    ).rejects.toThrow(/exit 1/);
  });

  it('throws AgentError when the stream has no valid JSON', async () => {
    const gen = new ClaudeCodeProvider().run(input(fakeSandbox('not json at all')));
    await expect(
      (async () => {
        for await (const turn of gen) void turn;
      })(),
    ).rejects.toThrow();
  });
});
