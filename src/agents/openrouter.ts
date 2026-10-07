import type { AgentProvider, AgentRunInput } from './provider.js';
import { runClaudeCli } from './claude-stream.js';
import { buildClaudeArgs } from './claude-code.js';
import { OPENROUTER_PRICING } from '../core/openrouter-pricing.js';
import { AgentError } from '../core/errors.js';

/** Default OpenRouter model (dotted slug, matches the `openRouterModel` keys in openrouter-pricing.ts). */
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
/** OpenRouter's Anthropic-Messages-compatible "skin", used as ANTHROPIC_BASE_URL (SDK appends /v1/messages). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/**
 * OpenRouter's Anthropic skin expects a `vendor/model` slug. A Claude CLI alias (`haiku`, the spec
 * default) or Anthropic id (`claude-sonnet-5`) is mapped through the pricing table's slug column; any
 * other bare name is rejected up front instead of surfacing as an opaque upstream 400 mid-run.
 */
export function toOpenRouterModel(model: string): string {
  if (model.includes('/')) return model;
  const slug = OPENROUTER_PRICING[model]?.openRouterModel;
  if (slug === undefined) {
    throw new AgentError(
      `openrouter: "${model}" is not an OpenRouter slug (vendor/model) and has no known mapping; ` +
        `pass e.g. ${OPENROUTER_DEFAULT_MODEL} or one of: ${Object.keys(OPENROUTER_PRICING).filter((k) => !k.includes('/')).join(', ')}.`,
    );
  }
  return slug;
}

// openrouter reuses the claude CLI args verbatim, but a model is always required: the CLI's own default
// targets a bare Anthropic model id, and OpenRouter's Anthropic skin expects a dotted OpenRouter slug.
const buildArgs = (input: AgentRunInput): string[] =>
  buildClaudeArgs({ ...input, model: toOpenRouterModel(input.model ?? OPENROUTER_DEFAULT_MODEL) });

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
