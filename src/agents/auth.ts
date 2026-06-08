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

/** Resolve auth from the environment, preferring the subscription token (Vanguard default). */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AgentAuth | undefined {
  const token = env[SUBSCRIPTION_ENV];
  if (token !== undefined && token !== '') return { mode: 'subscription', token };
  const apiKey = env[API_ENV];
  if (apiKey !== undefined && apiKey !== '') return { mode: 'api', apiKey };
  return undefined;
}
