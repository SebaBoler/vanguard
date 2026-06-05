import { describe, it, expect } from 'vitest';
import { authSecrets, authFromEnv, SUBSCRIPTION_ENV, API_ENV } from './auth.js';

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
