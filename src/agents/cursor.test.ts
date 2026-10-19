import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CursorProvider } from './cursor.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

/** The last exec (the `agent` call) plus every command in order (setup first). */
interface Captured {
  command: string;
  input: string | undefined;
  commands: string[];
}

function fakeSandbox(stdout: string, exitCode: number = 0, stderr: string = '', captured?: Captured): IsolatedSandboxProvider {
  return {
    exec: async (command: string, opts?: { input?: string }): Promise<ExecResult> => {
      if (captured !== undefined) {
        captured.command = command;
        captured.input = opts?.input;
        captured.commands.push(command);
      }
      return { stdout, stderr, exitCode };
    },
  } as unknown as IsolatedSandboxProvider;
}

// Recorded from CLI 2026.10.16-e3cb207 in the sandbox image (one edit, one shell call), with all but one
// `thinking` delta trimmed.
const recorded = readFileSync(new URL('./cursor-stream.fixture.ndjson', import.meta.url), 'utf8');

const SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';

// Shape of cursor.com/docs/cli/reference/output-format's example sequence (system/init, user, assistant
// segments around tool_call started/completed, terminal result).
const streamJson = [
  { type: 'system', subtype: 'init', apiKeySource: 'env', cwd: '/workspace', session_id: SESSION, model: 'Claude 4 Sonnet', permissionMode: 'default' },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] }, session_id: SESSION },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll read the file" }] }, session_id: SESSION },
  { type: 'tool_call', subtype: 'started', call_id: 't1', tool_call: { readToolCall: { args: { path: 'README.md' } } }, session_id: SESSION },
  {
    type: 'tool_call',
    subtype: 'completed',
    call_id: 't1',
    tool_call: { readToolCall: { args: { path: 'README.md' }, result: { success: { content: '# x', totalLines: 1 } } } },
    session_id: SESSION,
  },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\nDONE' }] }, session_id: SESSION },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 5234,
    duration_api_ms: 5234,
    is_error: false,
    result: "I'll read the fileDone.\nDONE",
    session_id: SESSION,
    request_id: 'r1',
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

function input(sandbox: IsolatedSandboxProvider, extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/home/agent', ...extra };
}

async function drain(sandbox: IsolatedSandboxProvider, extra: Partial<AgentRunInput> = {}): Promise<{ turns: string[]; out: AgentRunOutput }> {
  const gen = new CursorProvider().run(input(sandbox, extra));
  const turns: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value.text);
  }
}

async function capture(extra: Partial<AgentRunInput> = {}): Promise<Captured> {
  const captured: Captured = { command: '', input: undefined, commands: [] };
  await drain(fakeSandbox(streamJson, 0, '', captured), extra);
  return captured;
}

describe('CursorProvider', () => {
  it('parses the documented stream: segments as turns, last segment as finalText, init model, no usage/cost', async () => {
    const { turns, out } = await drain(fakeSandbox(streamJson));
    expect(turns).toEqual(["I'll read the file", 'Done.\nDONE']);
    expect(out.turns).toBe(2);
    expect(out.sessionId).toBe(SESSION);
    expect(out.finalText).toBe('Done.\nDONE');
    expect(out.model).toBe('Claude 4 Sonnet');
    expect(out.usage).toBeUndefined();
    expect(out.costUsd).toBeUndefined();
    expect(out.transcript).toBe(streamJson);
  });

  it('parses a recorded stream: thinking skipped, routing notice taken as the model, usage mapped', async () => {
    const { turns, out } = await drain(fakeSandbox(recorded));
    expect(turns).toEqual(['DONE']);
    expect(out.turns).toBe(1);
    expect(out.finalText).toBe('DONE');
    expect(out.sessionId).toBe('9b5b760d-5016-4e23-ab06-e3d2968346a6');
    expect(out.model).toBe('GPT-5.6 Sol');
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 137, cacheReadInputTokens: 30147 });
    expect(out.costUsd).toBeUndefined();
  });

  it('falls back to result.result when no assistant segment was streamed', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'GPT-5' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'only here', session_id: 's1' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(stream));
    expect(out.finalText).toBe('only here');
  });

  it('skips non-JSON diagnostic lines', async () => {
    const { out } = await drain(fakeSandbox(`WARN something\n${streamJson}`));
    expect(out.sessionId).toBe(SESSION);
  });

  it('does not throw on a non-zero exit when a success result was produced (graceful stop)', async () => {
    const { out } = await drain(fakeSandbox(streamJson, 1));
    expect(out.finalText).toBe('Done.\nDONE');
  });

  it('throws AgentError on an error result', async () => {
    const stream = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom', session_id: 's1' });
    await expect(drain(fakeSandbox(stream, 1))).rejects.toThrow(/error result \(error, exit 1\)/);
  });

  it('throws AgentError on a crash with no result', async () => {
    await expect(drain(fakeSandbox('fatal error', 1))).rejects.toThrow(/exit 1/);
  });

  it('throws AgentError when the stream has no valid JSON', async () => {
    await expect(drain(fakeSandbox('not json at all'))).rejects.toThrow(/no parseable output/);
  });

  it('throws AgentError when valid JSON is produced but no result message appears', async () => {
    const partial = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'GPT-5' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n');
    await expect(drain(fakeSandbox(partial))).rejects.toThrow(/without a result/);
  });

  it('redacts credentials in the error detail', async () => {
    const err = drain(fakeSandbox('', 1, 'auth failed: Authorization: Bearer abcdefghijklmnop1234'));
    await expect(err).rejects.toThrow(/Bearer \[REDACTED\]/);
    await expect(err).rejects.not.toThrow(/abcdefghijklmnop1234/);
  });

  it('runs headless: print mode, stream-json, trust, own sandbox off, prompt on stdin', async () => {
    const { command, input: stdin } = await capture();
    expect(command).toMatch(/^agent /);
    for (const flag of ["'-p'", "'stream-json'", "'--trust'", "'--sandbox' 'disabled'"]) expect(command).toContain(flag);
    expect(command).not.toContain('do it');
    expect(stdin).toBe('do it');
  });

  it('allowlists every command in cli-config.json before the run instead of --force (team admins can disable it)', async () => {
    const { commands } = await capture();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('cli-config.json');
    expect(commands[0]).toContain('"Shell(*)"');
    expect(commands[1]).toMatch(/^agent /);
    expect(commands[1]).not.toContain('--force');
  });

  it.each(['gpt-5.2', 'auto', 'claude-opus-5-5-high', 'claude-sonnet-5-thinking-high', 'claude-4.5-sonnet', 'auto-smart[optimize_for=cost]'])(
    'passes the Cursor model id %s through',
    async (model) => {
      const { command } = await capture({ model });
      expect(command).toContain(`'--model' '${model}'`);
    },
  );

  it.each([
    ['haiku', 'cost'],
    ['claude-haiku-4-5-20251001', 'cost'],
    ['sonnet', 'balanced'],
    ['claude-sonnet-5-5', 'balanced'],
    ['opus', 'intelligence'],
    ['claude-opus-4-8', 'intelligence'],
    ['fable', 'intelligence'],
    ['claude-fable-5-1', 'intelligence'],
    ['auto-intelligence', 'intelligence'],
    ['auto-balance', 'balanced'],
    ['auto-cost', 'cost'],
  ])('maps %s onto Auto %s', async (model, mode) => {
    const { command } = await capture({ model });
    expect(command).toContain(`'--model' 'auto-smart[optimize_for=${mode}]'`);
  });

  it('strips a routing notice that shares its segment with the answer (no tool call in between)', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'Auto Intelligence' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '> Auto routed to Grok 4.7\n\nPONG' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '> Auto routed to Grok 4.7\n\nPONG', session_id: 's1' }),
    ].join('\n');
    const { turns, out } = await drain(fakeSandbox(stream));
    expect(turns).toEqual(['PONG']);
    expect(out.finalText).toBe('PONG');
    expect(out.model).toBe('Grok 4.7');
  });

  it('passes a prototype key through as a model instead of mapping it', async () => {
    const { command } = await capture({ model: 'constructor' });
    expect(command).toContain("'--model' 'constructor'");
  });

  it('reports the Auto mode itself when no routing notice is streamed', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'Auto Cost' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: 's1' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(stream));
    expect(out.model).toBe('Auto Cost');
    expect(out.finalText).toBe('PONG');
  });

  it('resumes the chat by id', async () => {
    const { command } = await capture({ resumeSessionId: SESSION });
    expect(command).toContain(`'--resume' '${SESSION}'`);
  });

  it('leads the stdin prompt with the system prompt (no system-prompt flag)', async () => {
    const { input: stdin } = await capture({ systemPrompt: 'Read-only: do not edit files.' });
    expect(stdin).toBe('Read-only: do not edit files.\n\ndo it');
  });
});
