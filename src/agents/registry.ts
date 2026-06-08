import { ClaudeCodeProvider } from './claude-code.js';
import { CodexProvider } from './codex.js';
import { CursorProvider } from './cursor.js';
import { AgentError } from '../core/errors.js';
import type { AgentProvider } from './provider.js';

/** The providers selectable on the CLI. Selection is by provider, not by model. */
export const PROVIDER_NAMES = ['claude', 'codex', 'cursor'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Narrow an arbitrary string to a known provider name. */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Construct an AgentProvider by name (each runs on its own default model). */
export function makeProvider(name: ProviderName): AgentProvider {
  switch (name) {
    case 'claude':
      return new ClaudeCodeProvider();
    case 'codex':
      return new CodexProvider();
    case 'cursor':
      return new CursorProvider();
  }
}

interface ProviderKeyMapping {
  /** Host env var names to read the key from, in priority order. */
  hostEnv: string[];
  /** Env var name the CLI actually reads inside the sandbox. */
  sandboxEnv: string;
}

/**
 * How each non-default provider's API key flows into the sandbox. Claude's auth is handled separately
 * by authSecrets (subscription token or API key). Codex authenticates with OPENAI_API_KEY (its
 * API-key auth), which we read from the documented CODEX_API_KEY (or OPENAI_API_KEY) on the host.
 */
const PROVIDER_KEYS: Partial<Record<ProviderName, ProviderKeyMapping>> = {
  codex: { hostEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'], sandboxEnv: 'OPENAI_API_KEY' },
  cursor: { hostEnv: ['CURSOR_API_KEY'], sandboxEnv: 'CURSOR_API_KEY' },
};

/**
 * Collect the API-key secrets to forward for the given providers, read from env and keyed by the env
 * var the provider's CLI reads in the sandbox. Throws if a selected provider's key is missing, so a
 * cross-provider run fails fast at dispatch rather than mid-pipeline inside the sandbox. Claude needs
 * nothing here (covered by authSecrets).
 */
export function providerSecrets(
  names: Iterable<ProviderName>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const mapping = PROVIDER_KEYS[name];
    if (mapping === undefined) continue;
    const value = mapping.hostEnv.map((k) => env[k]).find((v) => v !== undefined && v !== '');
    if (value === undefined) {
      throw new AgentError(`Provider "${name}" needs ${mapping.hostEnv.join(' or ')} in the environment.`);
    }
    secrets[mapping.sandboxEnv] = value;
  }
  return secrets;
}

/** A run's provider choice: which provider implements, and optionally a different one for review. */
export interface ProviderChoice {
  /** Provider that implements (and, absent reviewProvider, runs every stage). Default 'claude'. */
  provider?: ProviderName;
  /** When set, run only the review stage on this provider (cross-provider review). */
  reviewProvider?: ProviderName;
}

/** A resolved choice: the agents to run and the API-key secrets to forward into the sandbox. */
export interface SelectedAgents {
  agent: AgentProvider;
  /** Present only when reviewProvider was set; pass to withStageProvider to route the review stage. */
  reviewAgent?: AgentProvider;
  secrets: Record<string, string>;
}

/**
 * Resolve a provider choice into agents + sandbox secrets, shared by every runner. Keeps provider
 * construction, the used-provider set, and the fail-fast key check in one place (no per-runner copy).
 */
export function selectAgents(choice: ProviderChoice, env: NodeJS.ProcessEnv = process.env): SelectedAgents {
  const provider = choice.provider ?? 'claude';
  const used = new Set<ProviderName>([provider, ...(choice.reviewProvider !== undefined ? [choice.reviewProvider] : [])]);
  return {
    agent: makeProvider(provider),
    ...(choice.reviewProvider !== undefined ? { reviewAgent: makeProvider(choice.reviewProvider) } : {}),
    secrets: providerSecrets(used, env),
  };
}
