import { describe, it, expect } from 'vitest';
import { buildMcpConfig, injectMcpServer, MCP_TOOL_NAMES } from './config.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

describe('buildMcpConfig', () => {
  it('wraps servers under mcpServers', () => {
    const json = buildMcpConfig({ vanguard: { command: 'node', args: ['/x.mjs'] } });
    expect(JSON.parse(json)).toEqual({ mcpServers: { vanguard: { command: 'node', args: ['/x.mjs'] } } });
  });
});

describe('injectMcpServer', () => {
  it('copies the server in, writes the config, and returns paths plus tool names', async () => {
    const copies: Array<[string, string]> = [];
    let configInput = '';
    const sandbox = {
      exec: async (cmd: string, opts?: { input?: string }) => {
        if (opts?.input !== undefined) configInput = opts.input;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      copyIn: async (host: string, sandboxPath: string) => {
        copies.push([host, sandboxPath]);
      },
    } as unknown as IsolatedSandboxProvider;
    const result = await injectMcpServer(sandbox);
    expect(result.mcpConfigPath).toBe('/workspace/.vanguard/mcp/mcp.json');
    expect(result.toolNames).toEqual(MCP_TOOL_NAMES);
    expect(copies[0]?.[1]).toBe('/workspace/.vanguard/mcp/typecheck-server.mjs');
    expect((JSON.parse(configInput) as { mcpServers: { vanguard: { command: string } } }).mcpServers.vanguard.command).toBe('node');
  });
});
