import { describe, it, expect } from 'vitest';
import { startLlmProxy } from './llm-proxy.js';

function fakeDocker(): { calls: { args: string[]; input?: string }[]; run: (args: string[], opts?: { input?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }> } {
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], opts?: { input?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('startLlmProxy', () => {
  it('delivers the secret off-argv and returns url + nonce', async () => {
    const d = fakeDocker();
    const proxy = await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'subscription', secret: 'OAT-SECRET' },
      docker: d.run,
    });
    expect(proxy.url).toMatch(/^http:\/\/vg-llm-.*:\d+$/);
    expect(proxy.nonce.length).toBeGreaterThanOrEqual(16);
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).not.toContain('OAT-SECRET'); // never on argv
    expect(d.calls.some((c) => c.input?.includes('OAT-SECRET'))).toBe(true); // delivered via stdin
    await proxy.destroy();
    expect(d.calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
  });

  it('labels the sidecar with vanguard.runId and starts the server', async () => {
    const d = fakeDocker();
    await startLlmProxy({
      network: 'vg-egr-x',
      auth: { mode: 'api', secret: 'sk-ant-secret' },
      docker: d.run,
    });
    const flat = d.calls.flatMap((c) => c.args).join(' ');
    expect(flat).toMatch(/--label vanguard\.runId=/);
    expect(flat).toContain('node /tmp/llm-proxy.mjs');
    expect(flat).toContain('LLM_PROXY_SECRET_FILE=/tmp/llm-proxy-secret');
    expect(flat).toContain('PORT=8088');
    // The secret travels only via stdin, never via -e or argv.
    expect(flat).not.toContain('sk-ant-secret');
    expect(d.calls.some((c) => c.input?.includes('sk-ant-secret'))).toBe(true);
  });

  it('returns a random nonce per run', async () => {
    const d = fakeDocker();
    const a = await startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: d.run });
    const b = await startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: d.run });
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('tears down the sidecar and wraps failures in SandboxError', async () => {
    const removed: string[][] = [];
    const run = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (args[0] === 'network' && args[1] === 'connect') throw new Error('boom');
      if (args[0] === 'rm') removed.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(
      startLlmProxy({ network: 'n', auth: { mode: 'api', secret: 's' }, docker: run }),
    ).rejects.toThrow(/Failed to start llm proxy/);
    expect(removed.some((a) => a.includes('-f'))).toBe(true);
  });
});
