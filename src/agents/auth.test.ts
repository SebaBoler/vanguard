import { describe, it, expect } from 'vitest';
import { authSecrets, authFromEnv, agentAuthFromEnv, SUBSCRIPTION_ENV, API_ENV } from './auth.js';

describe('authSecrets', () => {
  it('forwards only the OAuth token in subscription mode', () => {
    expect(authSecrets({ mode: 'subscription', token: 't' })).toEqual({ [SUBSCRIPTION_ENV]: 't' });
  });

  it('forwards only the API key in api mode', () => {
    expect(authSecrets({ mode: 'api', apiKey: 'k' })).toEqual({ [API_ENV]: 'k' });
  });
});

describe('authFromEnv', () => {
  it('prefers the subscription token when both are set', () => {
    expect(authFromEnv({ [SUBSCRIPTION_ENV]: 't', [API_ENV]: 'k' })).toEqual({ mode: 'subscription', token: 't' });
  });

  it('falls back to the API key', () => {
    expect(authFromEnv({ [API_ENV]: 'k' })).toEqual({ mode: 'api', apiKey: 'k' });
  });

  it('returns undefined when neither is set', () => {
    expect(authFromEnv({})).toBeUndefined();
  });
});

describe('agentAuthFromEnv', () => {
  it('resolves the z.ai key as an api-mode auth for --provider zai (no Anthropic token needed)', () => {
    expect(agentAuthFromEnv('zai', { ZAI_API_KEY: 'z-key' })).toEqual({ mode: 'api', apiKey: 'z-key' });
  });

  it('throws when ZAI_API_KEY is missing for zai', () => {
    expect(() => agentAuthFromEnv('zai', {})).toThrow(/ZAI_API_KEY/);
  });

  it('falls back to Anthropic auth for non-zai providers', () => {
    expect(agentAuthFromEnv('claude', { [API_ENV]: 'k' })).toEqual({ mode: 'api', apiKey: 'k' });
    expect(agentAuthFromEnv(undefined, { [SUBSCRIPTION_ENV]: 't' })).toEqual({ mode: 'subscription', token: 't' });
  });

  it('throws when Anthropic auth is missing for a non-zai provider', () => {
    expect(() => agentAuthFromEnv('codex', {})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
