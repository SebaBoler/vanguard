import { describe, it, expect } from 'vitest';
import { CodexProvider } from './codex.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

function capturingSandbox(): { sandbox: IsolatedSandboxProvider; captured: { command: string } } {
  const captured = { command: '' };
  return {
    captured,
    sandbox: {
      exec: async (command: string): Promise<ExecResult> => {
        captured.command = command;
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider,
  };
}

async function expectRunRejects(sandbox: IsolatedSandboxProvider, pattern: RegExp): Promise<void> {
  const gen = new CodexProvider().run(input(sandbox));
  await expect(
    (async () => {
      for await (const turn of gen) void turn;
    })(),
  ).rejects.toThrow(pattern);
}

const cannedJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'here is my answer' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 10 } }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root' };
}

async function drain(sandbox: IsolatedSandboxProvider): Promise<{ turns: string[]; out: AgentRunOutput }> {
  const gen = new CodexProvider().run(input(sandbox));
  const turns: string[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value.text);
  }
}

describe('CodexProvider', () => {
  it('parses JSONL into turns, sessionId, and usage', async () => {
    const { turns, out } = await drain(fakeSandbox(cannedJsonl));
    expect(turns).toEqual(['here is my answer']);
    expect(out.sessionId).toBe('codex-thread-1');
    expect(out.finalText).toBe('here is my answer');
    expect(out.usage?.inputTokens).toBe(100);
    expect(out.usage?.outputTokens).toBe(25);
    expect(out.usage?.cacheReadInputTokens).toBe(10);
  });

  it('skips non-JSON diagnostic lines', async () => {
    const { out } = await drain(fakeSandbox(`WARN: something\n${cannedJsonl}`));
    expect(out.sessionId).toBe('codex-thread-1');
  });

  it('does not throw on non-zero exit when turn.completed was received (graceful stop)', async () => {
    const { out } = await drain(fakeSandbox(cannedJsonl, 1));
    expect(out.finalText).toBe('here is my answer');
  });

  it('throws AgentError when no parseable output is produced', async () => {
    await expectRunRejects(fakeSandbox('fatal crash output', 1), /no parseable output/);
  });

  it('throws "without a result" (not "no parseable output") when only thread.started is received', async () => {
    await expectRunRejects(fakeSandbox(JSON.stringify({ type: 'thread.started', thread_id: 'x' })), /without a result/);
  });

  it('throws AgentError when turn.completed is missing', async () => {
    const partial = [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
    ].join('\n');
    await expectRunRejects(fakeSandbox(partial), /without a result/);
  });

  it('includes codex exec --json --sandbox danger-full-access in command', async () => {
    const { sandbox, captured } = capturingSandbox();
    const gen = new CodexProvider().run({ prompt: 'hello', sandbox, workdir: '/workspace', home: '/root' });
    for await (const turn of gen) void turn;
    expect(captured.command).toContain('codex');
    expect(captured.command).toContain('exec');
    expect(captured.command).toContain('--json');
    expect(captured.command).toContain('--sandbox');
    expect(captured.command).toContain('danger-full-access');
  });

  it('logs in with the API key (piped from env, not on argv) before exec', async () => {
    const commands: string[] = [];
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        commands.push(command);
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new CodexProvider().run(input(sandbox));
    for await (const turn of gen) void turn;
    expect(commands[0]).toContain('codex login --with-api-key');
    expect(commands[0]).toContain('$OPENAI_API_KEY'); // key read from env, never embedded on the command line
    expect(commands[1]).toContain('codex');
    expect(commands[1]).toContain('exec');
  });

  it('setup command (commands[0]) wires proxy mode without leaking the real key', async () => {
    const commands: string[] = [];
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        commands.push(command);
        return { stdout: cannedJsonl, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const gen = new CodexProvider().run(input(sandbox));
    for await (const turn of gen) void turn;
    const setup = commands[0];

    // branches at runtime on the runner-provided base URL
    expect(setup).toContain('VANGUARD_OPENAI_BASE_URL');
    expect(setup).toContain('if [ -n "${VANGUARD_OPENAI_BASE_URL:-}" ]; then');

    // writes config.toml under $CODEX_HOME (falling back to ~/.codex)
    expect(setup).toContain('mkdir -p "${CODEX_HOME:-$HOME/.codex}"');
    expect(setup).toContain('> "${CODEX_HOME:-$HOME/.codex}/config.toml"');

    // custom OpenAI-compatible provider config pointed at the sidecar
    expect(setup).toContain('model_provider = "vanguardproxy"');
    expect(setup).toContain('wire_api = "responses"');
    expect(setup).toContain('env_key = "OPENAI_API_KEY"');
    expect(setup).toContain('base_url = "%s"');
    expect(setup).toContain('"$VANGUARD_OPENAI_BASE_URL"'); // base url fed via printf %s, expanded in-sandbox

    // literal backslash-n reaches the sandbox so printf interprets the format string
    expect(setup).toContain('printf \'model_provider = "vanguardproxy"\\n[model_providers.vanguardproxy]');

    // fail-clearly guard when proxy mode is on but the nonce is missing
    expect(setup).toContain('if [ -z "${OPENAI_API_KEY:-}" ]; then');
    expect(setup).toContain('exit 1');

    // else branch still serves normal mode in the same single command
    expect(setup).toContain('codex login --with-api-key');

    // no literal API key: only env-var references are used to carry secrets
    expect(setup).not.toMatch(/--with-api-key\s+\S*sk-/);
    expect(setup).not.toContain('sk-');
    expect(setup).toContain('$OPENAI_API_KEY');
  });

  it('includes -m flag when model is specified', async () => {
    const { sandbox, captured } = capturingSandbox();
    const gen = new CodexProvider().run({ prompt: 'p', sandbox, workdir: '/workspace', home: '/root', model: 'o4-mini' });
    for await (const turn of gen) void turn;
    expect(captured.command).toContain('-m');
    expect(captured.command).toContain('o4-mini');
  });
});
