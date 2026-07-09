import type { AgentProvider, AgentRunInput } from './provider.js';
import { runClaudeCli } from './claude-stream.js';
import { buildClaudeArgs } from './claude-code.js';

/** Default OpenRouter model (dotted slug, matches the `openRouterModel` keys in openrouter-pricing.ts). */
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
/** OpenRouter's Anthropic-Messages-compatible "skin", used as ANTHROPIC_BASE_URL (SDK appends /v1/messages). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

// openrouter reuses the claude CLI args verbatim, but a model is always required: the CLI's own default
// targets a bare Anthropic model id, and OpenRouter's Anthropic skin expects a dotted OpenRouter slug.
const buildArgs = (input: AgentRunInput): string[] =>
  buildClaudeArgs({ ...input, model: input.model ?? OPENROUTER_DEFAULT_MODEL });

/**
 * Runs Claude Code by reusing the in-sandbox `claude` CLI pointed at OpenRouter's Anthropic-Messages-
 * compatible endpoint (the "Anthropic skin"). The transport is owned by the runner, not the provider: it
 * injects ANTHROPIC_BASE_URL=OPENROUTER_BASE_URL and ANTHROPIC_AUTH_TOKEN=<OpenRouter key> into the
 * sandbox (normal mode), or — under --llm-proxy — ANTHROPIC_BASE_URL=<sidecar> + the per-run nonce while a
 * trusted sidecar holds the real OpenRouter key. Everything else (stream parsing, graceful-exit invariant)
 * is identical to ClaudeCodeProvider and shared via runClaudeCli.
 *
 * Cost caveat: the claude CLI's `total_cost_usd` (if present) is computed client-side from Anthropic list
 * prices, not OpenRouter's actual charge. Use the `$or-est` estimate (src/core/openrouter-pricing.ts) for
 * an OpenRouter-priced figure.
 *
 * Provider pinning: OpenRouter recommends setting "Anthropic 1P" as the top-priority provider for Claude
 * Code compatibility. This is an OpenRouter ACCOUNT setting (provider-selection preferences), not
 * something this provider can set per-request — see docs/MIGRATION-openrouter-provider.md.
 */
export class OpenRouterProvider implements AgentProvider {
  readonly name = 'openrouter';

  run(input: AgentRunInput) {
    return runClaudeCli(input, buildArgs);
  }
}
