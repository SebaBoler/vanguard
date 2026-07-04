import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from './claude-code.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput } from './provider.js';

const streamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'done' }),
].join('\n');

describe('ClaudeCodeProvider', () => {
  it('wires into runClaudeCli and yields parsed turns (parsing details covered by claude-stream.test.ts)', async () => {
    const sandbox = {
      exec: async (): Promise<ExecResult> => ({ stdout: streamJson, stderr: '', exitCode: 0 }),
    } as unknown as IsolatedSandboxProvider;
    const gen = new ClaudeCodeProvider().run({ prompt: 'do it', sandbox, workdir: '/workspace', home: '/root' });
    const turns: string[] = [];
    for (;;) {
      const n = await gen.next();
      if (n.done) {
        expect(n.value.finalText).toBe('done');
        break;
      }
      turns.push(n.value.text);
    }
    expect(turns).toContain('working');
  });

  it('adds capability flags to the claude command', async () => {
    let captured = '';
    const sandbox = {
      exec: async (command: string): Promise<ExecResult> => {
        captured = command;
        return { stdout: streamJson, stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    const input: AgentRunInput = {
      prompt: 'p',
      sandbox,
      workdir: '/workspace',
      home: '/root',
      systemPrompt: 'SYS',
      mcpConfig: '/workspace/mcp.json',
      allowedTools: ['Read', 'Bash'],
      model: 'haiku',
      maxBudgetUsd: 0.5,
    };
    const gen = new ClaudeCodeProvider().run(input);
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
