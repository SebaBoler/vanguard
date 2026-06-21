import { describe, it, expect } from 'vitest';
import {
  mergeAnthropicBeta,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  isAllowedLlmPath,
  constantTimeEqual,
  upstreamPath,
  parseUnifiedRatelimit,
  writeQuotaSnapshot,
} from './llm-proxy-rewrite.mjs';
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others without leaking length via early return', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('upstreamPath', () => {
  it('prepends the z.ai Coding-Plan base path for the zai upstream', () => {
    expect(upstreamPath('zai', '/v1/messages')).toBe('/api/coding/paas/v4/v1/messages');
  });
  it('preserves query strings when prepending', () => {
    expect(upstreamPath('zai', '/v1/messages?beta=1')).toBe('/api/coding/paas/v4/v1/messages?beta=1');
  });
  it('passes through the path unchanged for anthropic (no base path)', () => {
    expect(upstreamPath('anthropic', '/v1/messages')).toBe('/v1/messages');
  });
  it('falls back to base path + "/" when reqUrl is undefined', () => {
    expect(upstreamPath('zai', undefined)).toBe('/api/coding/paas/v4/');
  });
});

describe('parseUnifiedRatelimit', () => {
  it('derives usedPct from remaining/limit and resetAt from epoch-seconds reset', () => {
    const snap = parseUnifiedRatelimit({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-remaining': '200',
      'anthropic-ratelimit-unified-limit': '1000',
      'anthropic-ratelimit-unified-reset': '1750000000',
    }, 1_700_000_000_000);
    expect(snap).toEqual({ usedPct: 80, resetAt: 1_750_000_000_000, fetchedAt: 1_700_000_000_000 });
  });

  it('falls back to status when no remaining/limit (rejected => 100)', () => {
    const snap = parseUnifiedRatelimit({ 'anthropic-ratelimit-unified-status': 'rejected' }, 5);
    expect(snap).toEqual({ usedPct: 100, resetAt: 0, fetchedAt: 5 });
  });

  it('returns undefined when no unified headers present', () => {
    expect(parseUnifiedRatelimit({ 'content-type': 'application/json' }, 5)).toBeUndefined();
  });

  it('handles array-valued headers and ISO reset', () => {
    const snap = parseUnifiedRatelimit({
      'anthropic-ratelimit-unified-remaining': ['0'],
      'anthropic-ratelimit-unified-limit': ['100'],
      'anthropic-ratelimit-unified-reset': '2025-01-01T00:00:00Z',
    }, 5);
    expect(snap?.usedPct).toBe(100);
    expect(snap?.resetAt).toBe(Date.parse('2025-01-01T00:00:00Z'));
  });
});

describe('writeQuotaSnapshot', () => {
  it('writes parseable JSON atomically and leaves no .tmp', () => {
    const path = join(tmpdir(), `vg-quota-${process.pid}.json`);
    rmSync(path, { force: true });
    writeQuotaSnapshot(path, { usedPct: 42, resetAt: 0, fetchedAt: 9 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ usedPct: 42, resetAt: 0, fetchedAt: 9 });
    const leftovers = readdirSync(tmpdir()).filter((f) => f.startsWith(`vg-quota-${process.pid}.json`) && f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    rmSync(path, { force: true });
    expect(existsSync(path)).toBe(false);
  });
});
