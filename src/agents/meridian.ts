import type { AgentProvider, AgentRunInput } from './provider.js';
import { runClaudeCli } from './claude-stream.js';
import { buildClaudeArgs } from './claude-code.js';

/**
 * Placeholder token injected as ANTHROPIC_AUTH_TOKEN when MERIDIAN_API_KEY is unset. A vanilla Meridian
 * authenticates through the Claude Code SDK on its own host (a `claude login` there) and ignores this
 * value — but the Claude CLI requires the env var to be set, and any non-empty string works. If the
 * endpoint is instead a keyed Anthropic-compatible proxy that validates a Bearer token (401 otherwise),
 * set MERIDIAN_API_KEY and it replaces this placeholder (registry passthroughEnv).
 */
export const MERIDIAN_PLACEHOLDER_TOKEN = 'meridian';

/**
 * Runs Claude by reusing the in-sandbox `claude` CLI pointed at a self-hosted Meridian instance
 * (https://github.com/rynfar/meridian) — an Anthropic-Messages-compatible proxy that bridges to the
 * Claude Code SDK, so a Claude Max subscription can be shared from one host (e.g. a NAS) to many
 * machines. The transport is owned by the runner, not the provider: it injects
 * ANTHROPIC_BASE_URL=<MERIDIAN_BASE_URL> and a placeholder ANTHROPIC_AUTH_TOKEN into the sandbox. Unlike
 * zai/openrouter the base URL is not a fixed constant — it is the operator's Meridian address, read from
 * MERIDIAN_BASE_URL (e.g. http://192.168.1.10:3456). Stream parsing + the graceful-exit invariant are
 * shared via runClaudeCli.
 *
 * Because Meridian relays real Claude through the SDK, no model is forced: the CLI's own default (or
 * --provider-model) passes straight through — this reuses buildClaudeArgs verbatim.
 *
 * Not compatible with --llm-proxy: the proxy sidecar exists to hold a real upstream credential, but
 * Meridian holds its own auth on its host and this provider carries only the base URL. Run Meridian in
 * normal (direct) mode. Under --egress, add the Meridian host to the egress allowlist (it is not a
 * default-allowed domain).
 */
export class MeridianProvider implements AgentProvider {
  readonly name = 'meridian';

  run(input: AgentRunInput) {
    return runClaudeCli(input, buildClaudeArgs);
  }
}
