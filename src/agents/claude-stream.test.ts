import { describe, it, expect } from 'vitest';
import { runClaudeCli } from './claude-stream.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

function capturingSandbox(
  stdout: string,
  exitCode: number = 0,
): { sandbox: IsolatedSandboxProvider; captured: { command: string; opts: Record<string, unknown> | undefined } } {
  const captured: { command: string; opts: Record<string, unknown> | undefined } = { command: '', opts: undefined };
  return {
    captured,
    sandbox: {
      exec: async (command: string, opts?: Record<string, unknown>): Promise<ExecResult> => {
        captured.command = command;
        captured.opts = opts;
        return { stdout, stderr: '', exitCode };
      },
    } as unknown as IsolatedSandboxProvider,
  };
}

const noArgs = (): string[] => [];

const streamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use' }, { type: 'text', text: '' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    result: 'done',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
    total_cost_usd: 0.01,
  }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root', ...overrides };
}

async function drain(
  sandbox: IsolatedSandboxProvider,
  overrides: Partial<AgentRunInput> = {},
): Promise<{ turns: Array<{ text: string; sessionId?: string }>; out: AgentRunOutput }> {
  const gen = runClaudeCli(input(sandbox, overrides), noArgs);
  const turns: Array<{ text: string; sessionId?: string }> = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value);
  }
}

async function expectRunRejects(
  sandbox: IsolatedSandboxProvider,
  pattern: RegExp,
  overrides: Partial<AgentRunInput> = {},
): Promise<void> {
  const gen = runClaudeCli(input(sandbox, overrides), noArgs);
  await expect(
    (async () => {
      for await (const turn of gen) void turn;
    })(),
  ).rejects.toThrow(pattern);
}

describe('runClaudeCli', () => {
  it('yields assistant turns in order, filtering non-text and empty-text blocks', async () => {
    const { turns, out } = await drain(fakeSandbox(streamJson));
    expect(turns.map((t) => t.text)).toEqual(['working']);
    expect(out.turns).toBe(1);
  });

  it('collects usage, cost, and result overrides finalText', async () => {
    const { out } = await drain(fakeSandbox(streamJson));
    expect(out.finalText).toBe('done');
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 });
    expect(out.costUsd).toBe(0.01);
  });

  it('does not throw on a non-zero exit when a result was produced (graceful stop e.g. max_turns)', async () => {
    const { out } = await drain(fakeSandbox(streamJson, 1));
    expect(out.finalText).toBe('done');
  });

  it('throws "without a result" on a non-zero exit with parsed output but no result event', async () => {
    const partial = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await expectRunRejects(fakeSandbox(partial, 1), /without a result/);
    await expectRunRejects(fakeSandbox(partial, 1), /exit 1/);
  });

  it('salvages a cut stream (exit 0 + assistant turns + session, no result) as an incomplete resumable run', async () => {
    const cut = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'writing tests' }] } }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(cut, 0));
    expect(out.finalText).toBe('writing tests'); // last streamed turn kept
    expect(out.sessionId).toBe('sess-1'); // session preserved → resume loop can continue
    expect(out.usage).toBeUndefined(); // no result event → no usage/cost
    expect(out.costUsd).toBeUndefined();
  });

  it('still throws on a cut stream with turns but no session id (nothing to resume)', async () => {
    const cut = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
    await expectRunRejects(fakeSandbox(cut, 0), /without a result/);
  });

  it('still throws on a clean exit with a session but zero assistant turns (no work to salvage)', async () => {
    const initOnly = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await expectRunRejects(fakeSandbox(initOnly, 0), /without a result/);
  });

  it('throws "no parseable output" when every line is non-JSON', async () => {
    await expectRunRejects(fakeSandbox('fatal crash output', 1), /no parseable output/);
    await expectRunRejects(fakeSandbox('fatal crash output', 1), /exit 1/);
  });

  it('throws "no parseable output" on empty stdout', async () => {
    await expectRunRejects(fakeSandbox('', 1), /no parseable output/);
  });

  it('skips interleaved non-JSON diagnostic lines without failing the parse', async () => {
    const withDiagnostics = `WARN: something noisy\n${streamJson}\nWARN: trailer`;
    const { out } = await drain(fakeSandbox(withDiagnostics));
    expect(out.sessionId).toBe('sess-1');
    expect(out.finalText).toBe('done');
  });

  it('captures session_id from the stream and seeds it from resumeSessionId when absent', async () => {
    const { out } = await drain(fakeSandbox(streamJson));
    expect(out.sessionId).toBe('sess-1');

    const noSessionStream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'hi' }),
    ].join('\n');
    const { turns, out: out2 } = await drain(fakeSandbox(noSessionStream), { resumeSessionId: 'resumed-1' });
    expect(out2.sessionId).toBe('resumed-1');
    expect(turns[0]?.sessionId).toBe('resumed-1');
  });

  it('captures model from a top-level field, or from nested message.model', async () => {
    const topLevelModelStream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', model: 'claude-x', result: 'done' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(topLevelModelStream));
    expect(out.model).toBe('claude-x');

    const nestedModelStream = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-y', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
    ].join('\n');
    const { out: out2 } = await drain(fakeSandbox(nestedModelStream));
    expect(out2.model).toBe('claude-y');
  });

  it('omits usage/cost/model/sessionId keys entirely when absent from the stream', async () => {
    const minimal = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
    const { out } = await drain(fakeSandbox(minimal));
    expect('usage' in out).toBe(false);
    expect('costUsd' in out).toBe(false);
    expect('model' in out).toBe(false);
    expect('sessionId' in out).toBe(false);
  });

  it('omits usage when the result event carries no usage field, even though result is present', async () => {
    const noUsage = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'done' });
    const { out } = await drain(fakeSandbox(noUsage));
    expect(out.finalText).toBe('done');
    expect('usage' in out).toBe(false);
  });

  it('feeds the prompt as exec input and runs a claude command', async () => {
    const { sandbox, captured } = capturingSandbox(streamJson);
    const { out } = await drain(sandbox);
    expect(out.finalText).toBe('done');
    expect(captured.command.startsWith('claude')).toBe(true);
    expect(captured.opts?.input).toBe('do it');
  });
});
