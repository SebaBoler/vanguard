import { describe, it, expect } from 'vitest';
import { mergeAnthropicBeta, upstreamAuthHeaders, isAllowedLlmPath, constantTimeEqual } from './llm-proxy-rewrite.mjs';

describe('mergeAnthropicBeta', () => {
  it('appends the oauth beta and dedupes, preserving request betas', () => {
    expect(mergeAnthropicBeta('foo-1,bar-2', 'oauth-2025-04-20')).toBe('foo-1,bar-2,oauth-2025-04-20');
    expect(mergeAnthropicBeta('oauth-2025-04-20,foo', 'oauth-2025-04-20')).toBe('oauth-2025-04-20,foo');
    expect(mergeAnthropicBeta(undefined, 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
  it('drops empty/whitespace segments', () => {
    expect(mergeAnthropicBeta('foo,,bar', 'oauth-2025-04-20')).toBe('foo,bar,oauth-2025-04-20');
    expect(mergeAnthropicBeta(' , ', 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
  it('coerces an array input to a comma-joined string', () => {
    expect(mergeAnthropicBeta(['foo', 'bar'], 'oauth-2025-04-20')).toBe('foo,bar,oauth-2025-04-20');
    expect(mergeAnthropicBeta(['oauth-2025-04-20'], 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
});

describe('upstreamAuthHeaders', () => {
  it('subscription: Bearer + merged oauth beta, drops x-api-key', () => {
    const h = upstreamAuthHeaders({ mode: 'subscription', secret: 'oat' }, { 'anthropic-beta': 'foo' });
    expect(h.authorization).toBe('Bearer oat');
    expect(h['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    expect('x-api-key' in h).toBe(false);
  });
  it('api: x-api-key, no oauth beta, no authorization', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, { 'anthropic-beta': 'foo' });
    expect(h['x-api-key']).toBe('sk-ant');
    expect('authorization' in h).toBe(false);
    expect(h['anthropic-beta']).toBe('foo'); // unchanged in api mode
  });
  it('api: omits anthropic-beta when the request has none', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, {});
    expect(h['x-api-key']).toBe('sk-ant');
    expect('anthropic-beta' in h).toBe(false);
    expect('authorization' in h).toBe(false);
  });
});

describe('isAllowedLlmPath', () => {
  it('allows only the two messages endpoints by POST', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true')).toBe(true); // query allowed
    expect(isAllowedLlmPath('GET', '/v1/messages')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/complete')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others without leaking length via early return', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
