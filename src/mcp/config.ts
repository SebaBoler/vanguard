import { fileURLToPath } from 'node:url';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

export const MCP_SERVER_NAME = 'vanguard';
const MCP_DIR = '/workspace/.vanguard/mcp';
const SERVER_FILE = `${MCP_DIR}/typecheck-server.mjs`;
const CONFIG_FILE = `${MCP_DIR}/mcp.json`;

export const MCP_TOOL_NAMES = [
  `mcp__${MCP_SERVER_NAME}__typecheck`,
  `mcp__${MCP_SERVER_NAME}__run_tests`,
  `mcp__${MCP_SERVER_NAME}__search_knowledge`,
  `mcp__${MCP_SERVER_NAME}__generate_edge_tests`,
  `mcp__${MCP_SERVER_NAME}__profile`,
];

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Build the --mcp-config JSON the claude CLI expects. */
export function buildMcpConfig(servers: Record<string, McpServerSpec>): string {
  return JSON.stringify({ mcpServers: servers });
}

/** Absolute path to the bundled zero-dep MCP server script, resolved relative to this module. */
export function serverScriptPath(): string {
  return fileURLToPath(new URL('./typecheck-server.mjs', import.meta.url));
}

export interface InjectedMcp {
  mcpConfigPath: string;
  toolNames: string[];
}

/**
 * Inject the bundled MCP server and its config into the sandbox. Returns the in-sandbox config path
 * (pass as StageInput.mcpConfig / RunOptions.mcpConfig) and the tool names (pass as allowedTools).
 */
export async function injectMcpServer(
  sandbox: IsolatedSandboxProvider,
  options: { typecheckCmd?: string; testCmd?: string; knowledgeDir?: string; profileCmd?: string; edgeTestCmd?: string } = {},
): Promise<InjectedMcp> {
  await sandbox.exec(`mkdir -p ${MCP_DIR}`);
  await sandbox.copyIn(serverScriptPath(), SERVER_FILE);
  const env: Record<string, string> = {};
  if (options.typecheckCmd !== undefined) env.MCP_TYPECHECK_CMD = options.typecheckCmd;
  if (options.testCmd !== undefined) env.MCP_TEST_CMD = options.testCmd;
  if (options.knowledgeDir !== undefined) env.MCP_KNOWLEDGE_DIR = options.knowledgeDir;
  if (options.profileCmd !== undefined) env.MCP_PROFILE_CMD = options.profileCmd;
  if (options.edgeTestCmd !== undefined) env.MCP_EDGETEST_CMD = options.edgeTestCmd;
  const config = buildMcpConfig({
    [MCP_SERVER_NAME]: {
      command: 'node',
      args: [SERVER_FILE],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  });
  await sandbox.exec(`cat > ${CONFIG_FILE}`, { input: config });
  return { mcpConfigPath: CONFIG_FILE, toolNames: [...MCP_TOOL_NAMES] };
}
