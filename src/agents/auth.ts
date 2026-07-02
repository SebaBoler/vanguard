import { anthropicTransportKeyEnv, needsAnthropicAuth } from './registry.js';
import type { ProviderChoice } from './registry.js';

export type AgentAuth = { mode: 'subscription'; token: string } | { mode: 'api'; apiKey: string };

export const SUBSCRIPTION_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
export const API_ENV = 'ANTHROPIC_API_KEY';

/**
 * Map an auth choice to the single secret env var to inject into the sandbox. Returns exactly one
 * key so billing is unambiguous (subscription never leaks the API key and vice versa).
 */
export function authSecrets(auth: AgentAuth): Record<string, string> {
  if (auth.mode === 'subscription') return { [SUBSCRIPTION_ENV]: auth.token };
  return { [API_ENV]: auth.apiKey };
}

/** Map an AgentAuth to the single-secret shape startLlmProxy wants (subscription token / api key). */
export function llmProxyAuth(auth: AgentAuth): { mode: 'subscription' | 'api'; secret: string } {
  return auth.mode === 'subscription'
    ? { mode: 'subscription', secret: auth.token }
    : { mode: 'api', secret: auth.apiKey };
}

/** Resolve Anthropic auth from the environment, preferring the subscription token (Vanguard default). */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AgentAuth | undefined {
  const token = env[SUBSCRIPTION_ENV];
  if (token !== undefined && token !== '') return { mode: 'subscription', token };
  const apiKey = env[API_ENV];
  if (apiKey !== undefined && apiKey !== '') return { mode: 'api', apiKey };
  return undefined;
}

/**
 * Resolve the run's auth for the chosen provider choice. For primary providers that own the Anthropic
 * transport (Zai/OpenRouter), their key is carried as an api-mode AgentAuth — it is NOT an Anthropic
 * credential, but it flows through the same auth slot so the proxy sidecar and dep threading stay
 * uniform. When no used provider needs an Anthropic-family credential, returns undefined rather than
 * throwing. Throws if a required credential is missing.
 */
export function agentAuthFromEnv(
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuth | undefined {
  const hostEnv = choice.provider !== undefined ? anthropicTransportKeyEnv(choice.provider) : undefined;
  if (hostEnv !== undefined) {
    const key = hostEnv.map((k) => env[k]).find((v) => v !== undefined && v !== '');
    if (key === undefined) {
      throw new Error(`Set ${hostEnv.join(' or ')} before running with --provider ${choice.provider}.`);
    }
    return { mode: 'api', apiKey: key };
  }
  if (!needsAnthropicAuth(choice)) return undefined; // suppressed (e.g. codex/cursor + zai review): no Anthropic credential is consumed
  const auth = authFromEnv(env);
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  return auth;
}
