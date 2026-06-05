import { describe, it, expect } from 'vitest';
import { handleRequest } from './typecheck-server.mjs';
import type { CommandRunner } from './typecheck-server.mjs';

const fakeRun: CommandRunner = async (command) => ({ code: command.includes('typecheck') ? 0 : 1, out: `ran: ${command}` });

describe('mcp typecheck-server handleRequest', () => {
  it('responds to initialize with serverInfo and the echoed protocol version', async () => {
    const res = await handleRequest({ method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18' } });
    const result = res.result as { serverInfo: { name: string }; protocolVersion: string };
    expect(result.serverInfo.name).toBe('vanguard');
    expect(result.protocolVersion).toBe('2025-06-18');
  });

  it('lists the typecheck and run_tests tools', async () => {
    const res = await handleRequest({ method: 'tools/list', id: 2 });
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toEqual(['typecheck', 'run_tests']);
  });

  it('runs a tool via tools/call and reports the exit code', async () => {
    const res = await handleRequest({ method: 'tools/call', id: 3, params: { name: 'typecheck' } }, fakeRun);
    const result = res.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.content[0]?.text).toContain('exit 0');
    expect(result.isError).toBe(false);
  });

  it('errors on an unknown tool', async () => {
    const res = await handleRequest({ method: 'tools/call', id: 4, params: { name: 'nope' } });
    expect(res.error?.code).toBe(-32602);
  });

  it('errors on an unknown method', async () => {
    const res = await handleRequest({ method: 'foo/bar', id: 5 });
    expect(res.error?.code).toBe(-32601);
  });
});
