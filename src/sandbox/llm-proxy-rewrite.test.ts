import { describe, it, expect } from 'vitest';
import {
  mergeAnthropicBeta,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  zaiAuthHeaders,
  isAllowedLlmPath,
  constantTimeEqual,
} from './llm-proxy-rewrite.mjs';

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

  it('defaults to anthropic when no upstream arg is given', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'anthropic')).toBe(isAllowedLlmPath('POST', '/v1/messages'));
    expect(isAllowedLlmPath('POST', '/v1/responses')).toBe(false); // anthropic default rejects responses
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
  });

  it('openai: allows only POST /v1/responses (query ignored)', () => {
    expect(isAllowedLlmPath('POST', '/v1/responses', 'openai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/responses?x=1', 'openai')).toBe(true);
    expect(isAllowedLlmPath('GET', '/v1/responses', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/messages', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/chat/completions', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models', 'openai')).toBe(false);
  });
});

describe('openaiAuthHeaders', () => {
  it('returns only a Bearer authorization header', () => {
    const h = openaiAuthHeaders('sk-openai');
    expect(h.authorization).toBe('Bearer sk-openai');
    expect('anthropic-beta' in h).toBe(false);
    expect('x-api-key' in h).toBe(false);
    expect(Object.keys(h)).toEqual(['authorization']);
  });
});

describe('isAllowedLlmPath (zai)', () => {
  it('accepts the anthropic-compatible paths z.ai serves and rejects the rest', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'zai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens', 'zai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true', 'zai')).toBe(true);
    // z.ai is not OpenAI-Responses-compatible.
    expect(isAllowedLlmPath('POST', '/v1/responses', 'zai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/chat/completions', 'zai')).toBe(false);
    expect(isAllowedLlmPath('GET', '/v1/messages', 'zai')).toBe(false);
  });
});

describe('zaiAuthHeaders', () => {
  it('returns only a Bearer authorization header (no anthropic-beta, no x-api-key)', () => {
    const h = zaiAuthHeaders('zai-key');
    expect(h.authorization).toBe('Bearer zai-key');
    expect('anthropic-beta' in h).toBe(false);
    expect('x-api-key' in h).toBe(false);
    expect(Object.keys(h)).toEqual(['authorization']);
  });
});

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others without leaking length via early return', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
