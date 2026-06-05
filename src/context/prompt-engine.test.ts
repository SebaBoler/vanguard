import { describe, it, expect } from 'vitest';
import { renderPrompt } from './prompt-engine.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';

function fakeSandbox(handler: (cmd: string) => string): IsolatedSandboxProvider {
  return {
    exec: async (cmd: string): Promise<ExecResult> => ({ stdout: handler(cmd), stderr: '', exitCode: 0 }),
  } as unknown as IsolatedSandboxProvider;
}

describe('renderPrompt', () => {
  it('substitutes {{KEY}} placeholders', async () => {
    const out = await renderPrompt('Hi {{NAME}}', { variables: { NAME: 'Seba' }, sandbox: fakeSandbox(() => '') });
    expect(out).toBe('Hi Seba');
  });

  it('expands sandbox command output', async () => {
    const out = await renderPrompt('Logs:\n!`cat log`', {
      variables: {},
      sandbox: fakeSandbox((cmd) => (cmd === 'cat log' ? 'LOG-OUT' : '')),
    });
    expect(out).toContain('LOG-OUT');
  });

  it('leaves unknown keys empty', async () => {
    const out = await renderPrompt('x={{MISSING}}', { variables: {}, sandbox: fakeSandbox(() => '') });
    expect(out).toBe('x=');
  });

  it('does not treat $ in command stdout as a replacement pattern', async () => {
    const out = await renderPrompt('cost: !`echo`', { variables: {}, sandbox: fakeSandbox(() => '$5 ($$ saved) $&') });
    expect(out).toBe('cost: $5 ($$ saved) $&');
  });

  it('expands duplicate command tokens independently', async () => {
    let n = 0;
    const out = await renderPrompt('!`seq` and !`seq`', { variables: {}, sandbox: fakeSandbox(() => String(++n)) });
    expect(out).toBe('1 and 2');
  });
});
