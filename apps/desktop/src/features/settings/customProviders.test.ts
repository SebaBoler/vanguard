import { describe, expect, it } from 'vitest';
import { customProviderRowError, PROVIDERS } from './customProviders';

const ROW = { name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_API_KEY' };

describe('customProviderRowError (grammar mirror of the core predicate)', () => {
  it('accepts the reference row with and without model', () => {
    expect(customProviderRowError(ROW, 0, [ROW])).toBeUndefined();
    expect(customProviderRowError({ ...ROW, model: 'glm-5.2' }, 0, [ROW])).toBeUndefined();
  });

  it.each([
    ['bad name grammar', { ...ROW, name: 'My-Proxy' }, /lowercase/],
    ['empty name', { ...ROW, name: '' }, /lowercase/],
    ['built-in collision', { ...ROW, name: 'zai' }, /built-in/],
    ['relative baseUrl', { ...ROW, baseUrl: '/api' }, /absolute http/],
    ['bad keyEnv', { ...ROW, keyEnv: '1BAD' }, /environment variable/],
    ['empty model', { ...ROW, model: '' }, /non-empty/],
  ])('rejects %s', (_label, row, re) => {
    expect(customProviderRowError(row, 0, [row])).toMatch(re);
  });

  it('flags an unknown key from a hand-edited file — core would reject it at run time', () => {
    const row = { ...ROW, futureKey: true } as typeof ROW;
    expect(customProviderRowError(row, 0, [row])).toMatch(/unknown key "futureKey"/);
  });

  it('flags the SECOND duplicate, not the first', () => {
    const rows = [ROW, { ...ROW }];
    expect(customProviderRowError(rows[0]!, 0, rows)).toBeUndefined();
    expect(customProviderRowError(rows[1]!, 1, rows)).toMatch(/duplicate/);
  });

  it('PROVIDERS mirrors the six built-ins', () => {
    expect(PROVIDERS).toEqual(['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian']);
  });
});
