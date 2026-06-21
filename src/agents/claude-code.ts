import type { AgentProvider, AgentRunInput } from './provider.js';
import { runClaudeCli } from './claude-stream.js';

/** Build the `claude` CLI arg list from a run input. Exported so ZaiProvider reuses it (same CLI). */
export function buildClaudeArgs(input: AgentRunInput): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
  if (input.effort !== undefined) args.push('--effort', input.effort);
  if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns));
  if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd));
  if (input.resumeSessionId !== undefined) args.push('--resume', input.resumeSessionId);
  if (input.forkSession === true) args.push('--fork-session');
  if (input.systemPrompt !== undefined) args.push('--append-system-prompt', input.systemPrompt);
  if (input.mcpConfig !== undefined) args.push('--mcp-config', input.mcpConfig, '--strict-mcp-config');
  if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
    args.push('--allowed-tools', ...input.allowedTools);
  }
  if (input.model !== undefined) args.push('--model', input.model);
  return args;
}

/**
 * Runs the in-sandbox `claude` CLI (Anthropic). Auth and the upstream endpoint are owned by the runner:
 * authSecrets injects CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY (or, under --llm-proxy, the sidecar's
 * ANTHROPIC_BASE_URL + per-run nonce). Stream parsing + the graceful-exit invariant live in the shared
 * `runClaudeCli` (also used by ZaiProvider, which reuses this same CLI against z.ai's endpoint).
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code';

  run(input: AgentRunInput) {
    return runClaudeCli(input, buildClaudeArgs);
  }
}
