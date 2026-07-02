import { describe, it, expect } from 'vitest';
import { CursorProvider } from './cursor.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

const streamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-sess-1', model: 'cursor-small' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }),
  JSON.stringify({
    type: 'result',
    finalText: 'all done',
    usage: { inputTokens: 200, outputTokens: 40 },
    costUsd: 0.02,
  }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root' };
}

async function drain(sandbox: IsolatedSandboxProvider): Promise<{ turns: string[]; out: AgentRunOutput }> {
  const gen = new CursorProvider().run(input(sandbox));
  const turns: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value.text);
  }
}

describe('CursorProvider', () => {
  it('parses stream-json into turns and captures sessionId, usage, cost', async () => {
    const { turns, out } = await drain(fakeSandbox(streamJson));
    expect(turns).toContain('working on it');
    expect(out.sessionId).toBe('cursor-sess-1');
    expect(out.finalText).toBe('all done');
    expect(out.usage?.inputTokens).toBe(200);
    expect(out.usage?.outputTokens).toBe(40);
    expect(out.costUsd).toBe(0.02);
    expect(out.model).toBe('cursor-small');
  });

  it('skips non-JSON diagnostic lines', async () => {
    const { out } = await drain(fakeSandbox(`WARN something\n${streamJson}`));
    expect(out.sessionId).toBe('cursor-sess-1');
  });

  it('does not throw on a non-zero exit when a result was produced (graceful stop)', async () => {
    const { out } = await drain(fakeSandbox(streamJson, 1));
    expect(out.finalText).toBe('all done');
  });

  it('throws AgentError on a crash with no result', async () => {
    const gen = new CursorProvider().run(input(fakeSandbox('fatal error', 1)));
    await expect(
      (async () => {
        for await (const turn of gen) void turn;
      })(),
    ).rejects.toThrow(/exit 1/);
  });

  it('throws AgentError when the stream has no valid JSON', async () => {
    const gen = new CursorProvider().run(input(fakeSandbox('not json at all')));
    await expect(
      (async () => {
        for await (const turn of gen) void turn;
      })(),
    ).rejects.toThrow();
  });

  it('throws AgentError when valid JSON is produced but no result message appears', async () => {
    const partialStream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'cursor-small' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n');
    const gen = new CursorProvider().run(input(fakeSandbox(partialStream)));
    await expect(
      (async () => {
        for await (const turn of gen) void turn;
      })(),
    ).rejects.toThrow(/without a result/);
  });

  it('includes --model flag when model is specified', async () => {
    let captured = '';
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        captured = command;
        return { stdout: streamJson, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new CursorProvider().run({ prompt: 'p', sandbox, workdir: '/workspace', home: '/root', model: 'cursor-large' });
    for await (const turn of gen) void turn;
    expect(captured).toContain('--model');
    expect(captured).toContain('cursor-large');
    expect(captured).toContain('--force');
    expect(captured).toContain('-p');
  });
});
