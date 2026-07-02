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
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    result: 'done',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
    total_cost_usd: 0.01,
  }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root', effort: 'high' };
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
    expect(turns).toContain('working');
    expect(out.sessionId).toBe('sess-1');
    expect(out.finalText).toBe('done');
    expect(out.usage?.cacheReadInputTokens).toBe(80);
    expect(out.costUsd).toBe(0.01);
  });

  it('captures the model reported in the result message', async () => {
    const resultModelStream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        model: 'claude-sonnet-4-20250514',
        result: 'done',
      }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(resultModelStream));
    expect(out.model).toBe('claude-sonnet-4-20250514');
  });

  it('captures the model reported in nested assistant messages', async () => {
    const assistantModelStream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-20250514',
          content: [{ type: 'text', text: 'working' }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'done' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(assistantModelStream));
    expect(out.model).toBe('claude-opus-4-20250514');
  });

  it('skips non-JSON diagnostic lines', async () => {
    const { out } = await drain(fakeSandbox(`WARN something\n${streamJson}`));
    expect(out.sessionId).toBe('sess-1');
  });

  it('does not throw on a non-zero exit when a result was produced (graceful stop like max_turns)', async () => {
    const { out } = await drain(fakeSandbox(streamJson, 1));
    expect(out.finalText).toBe('done');
  });

  it('throws AgentError on a crash with no result (non-zero exit, no result line)', async () => {
    const gen = new ClaudeCodeProvider().run(input(fakeSandbox('boom: fatal', 1)));
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

  it('adds capability flags to the claude command', async () => {
    let captured = '';
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        captured = command;
        return { stdout: streamJson, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new ClaudeCodeProvider().run({
      prompt: 'p',
      sandbox,
      workdir: '/workspace',
      home: '/root',
      systemPrompt: 'SYS',
      mcpConfig: '/workspace/mcp.json',
      allowedTools: ['Read', 'Bash'],
      model: 'haiku',
      maxBudgetUsd: 0.5,
    });
    for await (const turn of gen) void turn;
    expect(captured).toContain('--append-system-prompt');
    expect(captured).toContain('--mcp-config');
    expect(captured).toContain('--strict-mcp-config');
    expect(captured).toContain('--allowed-tools');
    expect(captured).toContain('--model');
    expect(captured).toContain('--max-budget-usd');
    expect(captured).toContain('0.5');
  });
});
