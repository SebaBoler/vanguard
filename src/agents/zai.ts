import type { AgentProvider, AgentRunInput } from './provider.js';
import { runClaudeCli } from './claude-stream.js';
import { buildClaudeArgs } from './claude-code.js';

/** Default z.ai coding model (GLM Coding Plan). Overridable per-run via --provider-model. */
export const ZAI_DEFAULT_MODEL = 'glm-5.2';
/** z.ai GLM Coding Plan endpoint — Anthropic-Messages-compatible, used as ANTHROPIC_BASE_URL. */
export const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

// zai reuses the claude CLI args verbatim, but a model is always required: z.ai's endpoint serves GLM,
// and the CLI's own default targets a Claude model z.ai does not serve. So force the GLM default.
const buildArgs = (input: AgentRunInput): string[] =>
  buildClaudeArgs({ ...input, model: input.model ?? ZAI_DEFAULT_MODEL });

/**
 * Runs z.ai's GLM Coding Plan by reusing the in-sandbox `claude` CLI pointed at z.ai's
 * Anthropic-Messages-compatible coding endpoint. The transport is owned by the runner, not the
 * provider: it injects ANTHROPIC_BASE_URL=ZAI_BASE_URL and ANTHROPIC_AUTH_TOKEN=<z.ai key> into the
 * sandbox (normal mode), or — under --llm-proxy — ANTHROPIC_BASE_URL=<sidecar> + the per-run nonce
 * while a trusted sidecar holds the real z.ai key. Everything else (stream parsing, graceful-exit
 * invariant) is identical to ClaudeCodeProvider and shared via runClaudeCli.
 *
 * Why reuse the Claude CLI rather than the codex CLI: z.ai's coding endpoint is advertised as
 * compatible with "Claude Code and Cline" (it speaks the Anthropic Messages API), and the codex CLI
 * (0.120.0) dropped wire_api="chat" so it can no longer target /chat/completions.
 */
export class ZaiProvider implements AgentProvider {
  readonly name = 'zai';

  run(input: AgentRunInput) {
    return runClaudeCli(input, buildArgs);
  }
}
