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

/** Options controlling how provider secrets are routed. */
export interface ProviderSecretOptions {
  /** When true (--llm-proxy active), keys for proxyable non-Claude providers are held back from the sandbox. */
  proxyMode?: boolean;
}

/** Real provider keys held by trusted sidecars (proxy mode) — never injected into the sandbox. */
export interface ProviderProxySecrets {
  /** Real OpenAI/Codex key, owned by the OpenAI proxy sidecar instead of the sandbox. */
  codex?: string;
}

interface ProviderKeyMapping {
  /** Host env var names to read the key from, in priority order. */
  hostEnv: string[];
  /** Env var name the CLI actually reads inside the sandbox. */
  sandboxEnv: string;
  /** When set and proxyMode is on, the key is held by a sidecar under this name instead of injected into the sandbox. */
  proxyKey?: keyof ProviderProxySecrets;
}

/**
 * How each non-default provider's API key flows into the sandbox. Claude's auth is handled separately
 * by authSecrets (subscription token or API key). Codex authenticates with OPENAI_API_KEY (its
 * API-key auth), which we read from the documented CODEX_API_KEY (or OPENAI_API_KEY) on the host.
 */
export const PROVIDER_KEYS: Partial<Record<ProviderName, ProviderKeyMapping>> = {
  codex: { hostEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'], sandboxEnv: 'OPENAI_API_KEY', proxyKey: 'codex' },
  cursor: { hostEnv: ['CURSOR_API_KEY'], sandboxEnv: 'CURSOR_API_KEY' },
};

/**
 * Collect the API-key secrets for the given providers, read from env and split into two buckets:
 * `sandboxSecrets` (keyed by the env var the provider's CLI reads inside the sandbox) and
 * `proxySecrets` (real keys held by trusted sidecars, never injected into the sandbox). Throws if a
 * selected provider's key is missing — the key is required whether it goes to the sandbox or a
 * sidecar — so a cross-provider run fails fast at dispatch rather than mid-pipeline inside the
 * sandbox. Claude needs nothing here (covered by authSecrets).
 *
 * Routing per used provider:
 * - In proxy mode (`opts.proxyMode === true`), a provider with a `proxyKey` mapping has its real key
 *   routed to `proxySecrets[proxyKey]` and kept out of `sandboxSecrets`.
 * - Otherwise the key is placed in `sandboxSecrets[sandboxEnv]` (the normal sandbox-injected path).
 *
 * Invariant: in proxy mode a proxyable provider's real key never lands in `sandboxSecrets`. Concretely,
 * if Codex is selected and `proxyMode` is true, `sandboxSecrets` must NOT contain `OPENAI_API_KEY`.
 */
export function providerSecrets(
  names: Iterable<ProviderName>,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProviderSecretOptions = {},
): { sandboxSecrets: Record<string, string>; proxySecrets: ProviderProxySecrets } {
  const sandboxSecrets: Record<string, string> = {};
  const proxySecrets: ProviderProxySecrets = {};
  for (const name of names) {
    const mapping = PROVIDER_KEYS[name];
    if (mapping === undefined) continue;
    const value = mapping.hostEnv.map((k) => env[k]).find((v) => v !== undefined && v !== '');
    if (value === undefined) {
      throw new AgentError(`Provider "${name}" needs ${mapping.hostEnv.join(' or ')} in the environment.`);
    }
    if (opts.proxyMode === true && mapping.proxyKey !== undefined) {
      proxySecrets[mapping.proxyKey] = value;
    } else {
      sandboxSecrets[mapping.sandboxEnv] = value;
    }
  }
  return { sandboxSecrets, proxySecrets };
}

/** A run's provider choice: which provider implements, and optionally a different one for review. */
export interface ProviderChoice {
  /** Provider that implements (and, absent reviewProvider, runs every stage). Default 'claude'. */
  provider?: ProviderName;
  /** When set, run only the review stage on this provider (cross-provider review). */
  reviewProvider?: ProviderName;
}

/** A resolved choice: the agents to run plus the secrets split into sandbox-safe and proxy-held buckets. */
export interface SelectedAgents {
  agent: AgentProvider;
  /** Present only when reviewProvider was set; pass to withStageProvider to route the review stage. */
  reviewAgent?: AgentProvider;
  /** Sandbox-safe secrets injected into the sandbox env. */
  secrets: Record<string, string>;
  /** Real provider keys held by trusted sidecars (proxy mode); never injected into the sandbox. */
  proxySecrets: ProviderProxySecrets;
}

/**
 * Resolve a provider choice into agents + split secrets, shared by every runner. Keeps provider
 * construction, the used-provider set, and the fail-fast key check in one place (no per-runner copy).
 * `secrets` is the sandbox-safe bucket (injected into the sandbox); `proxySecrets` holds real keys for
 * trusted sidecars in proxy mode. Invariant: in proxy mode a proxyable provider's real key never lands
 * in `secrets` — e.g. proxy-mode Codex keeps `OPENAI_API_KEY` out of `secrets` and puts it in
 * `proxySecrets.codex`.
 */
export function selectAgents(
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProviderSecretOptions = {},
): SelectedAgents {
  const provider = choice.provider ?? 'claude';
  const used = new Set<ProviderName>([provider, ...(choice.reviewProvider !== undefined ? [choice.reviewProvider] : [])]);
  const { sandboxSecrets, proxySecrets } = providerSecrets(used, env, opts);
  return {
    agent: makeProvider(provider),
    ...(choice.reviewProvider !== undefined ? { reviewAgent: makeProvider(choice.reviewProvider) } : {}),
    secrets: sandboxSecrets,
    proxySecrets,
  };
}
