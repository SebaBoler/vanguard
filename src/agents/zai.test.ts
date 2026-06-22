import { describe, it, expect } from 'vitest';
import { ZaiProvider, ZAI_DEFAULT_MODEL, ZAI_BASE_URL } from './zai.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

const streamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'zai-sess-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answering via glm' }] } }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'zai-sess-1',
    result: 'final',
    usage: { input_tokens: 50, output_tokens: 12, cache_read_input_tokens: 30 },
  }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root', effort: 'medium' };
}

async function drain(sandbox: IsolatedSandboxProvider): Promise<{ turns: string[]; out: AgentRunOutput }> {
  const gen = new ZaiProvider().run(input(sandbox));
  const turns: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value.text);
  }
}

async function captureCommand(extra: Partial<AgentRunInput> = {}): Promise<string> {
  let captured = '';
  const sandbox = {
    exec: async (command: string): Promise<ExecResult> => {
      captured = command;
      return { stdout: streamJson, stderr: '', exitCode: 0 };
    },
  } as unknown as IsolatedSandboxProvider;
  const gen = new ZaiProvider().run({ prompt: 'p', sandbox, workdir: '/workspace', home: '/root', ...extra });
  for await (const turn of gen) void turn;
  return captured;
}

describe('ZaiProvider', () => {
  it('parses the stream-json identically to the claude provider (shared runClaudeCli)', async () => {
    const { turns, out } = await drain(fakeSandbox(streamJson));
    expect(turns).toContain('answering via glm');
    expect(out.sessionId).toBe('zai-sess-1');
    expect(out.finalText).toBe('final');
    expect(out.usage?.outputTokens).toBe(12);
    expect(out.usage?.cacheReadInputTokens).toBe(30);
  });

  it('always passes --model, defaulting to the z.ai coding model when none is given', async () => {
    const cmd = await captureCommand();
    expect(cmd).toContain('--model');
    expect(cmd).toContain(ZAI_DEFAULT_MODEL);
  });

  it('respects an explicit --provider-model override', async () => {
    const cmd = await captureCommand({ model: 'glm-4.6' });
    expect(cmd).toContain('--model');
    expect(cmd).toContain('glm-4.6');
    expect(cmd).not.toContain(`'${ZAI_DEFAULT_MODEL}'`);
  });

  it('uses the same claude CLI + capability flags as the claude provider', async () => {
    const cmd = await captureCommand({ systemPrompt: 'SYS', mcpConfig: '/workspace/mcp.json', allowedTools: ['Read'] });
    expect(cmd.startsWith('claude ')).toBe(true);
    expect(cmd).toContain('--print');
    expect(cmd).toContain('--output-format');
    expect(cmd).toContain('stream-json');
    expect(cmd).toContain('--append-system-prompt');
    expect(cmd).toContain('--mcp-config');
    expect(cmd).toContain('--strict-mcp-config');
    expect(cmd).toContain('--allowed-tools');
  });

  it('does not throw on a non-zero exit when a result was produced (graceful stop)', async () => {
    const { out } = await drain(fakeSandbox(streamJson, 1));
    expect(out.finalText).toBe('final');
  });

  it('throws AgentError on a crash with no result', async () => {
    const gen = new ZaiProvider().run(input(fakeSandbox('fatal glm error', 1)));
    await expect(
      (async () => {
        for await (const turn of gen) void turn;
      })(),
    ).rejects.toThrow(/exit 1/);
  });

  it('exposes the z.ai coding endpoint base URL constant', () => {
    expect(ZAI_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4');
  });
});
