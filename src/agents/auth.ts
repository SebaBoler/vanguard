import type { ProviderName } from './registry.js';

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
 * Resolve the run's auth for the chosen provider. For Zai, the z.ai key (ZAI_API_KEY) is carried as an
 * api-mode AgentAuth — it is NOT an Anthropic credential, but it flows through the same auth slot so the
 * proxy sidecar and dep threading stay uniform. It is only consumed two ways: (1) the primary sidecar
 * under --llm-proxy (startSandboxContext forwards it to api.z.ai as a bearer key), and (2) it is held
 * back from the sandbox in normal mode (selectAgents sets injectAnthropicAuth=false for Zai, so the
 * z.ai transport comes from agents.secrets = ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN instead). Throws
 * if a required credential is missing. For every non-Zai provider the Anthropic token is required (it is
 * the default transport, and even Codex/Cursor runs have historically injected it).
 */
export function agentAuthFromEnv(
  provider: ProviderName | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuth {
  if (provider === 'zai') {
    const key = env['ZAI_API_KEY'];
    if (key === undefined || key === '') {
      throw new Error('Set ZAI_API_KEY before running with --provider zai.');
    }
    return { mode: 'api', apiKey: key };
  }
  const auth = authFromEnv(env);
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  return auth;
}
