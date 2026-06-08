import { describe, it, expect } from 'vitest';
import { isProviderName, makeProvider, providerSecrets, PROVIDER_NAMES } from './registry.js';

describe('isProviderName', () => {
  it('accepts known providers and rejects others', () => {
    for (const name of PROVIDER_NAMES) expect(isProviderName(name)).toBe(true);
    expect(isProviderName('gpt')).toBe(false);
    expect(isProviderName('')).toBe(false);
  });
});

describe('makeProvider', () => {
  it('constructs the matching provider for each name', () => {
    expect(makeProvider('claude').name).toBe('claude-code');
    expect(makeProvider('codex').name).toBe('codex');
    expect(makeProvider('cursor').name).toBe('cursor');
  });
});

describe('providerSecrets', () => {
  it('returns nothing for claude (auth handled separately)', () => {
    expect(providerSecrets(['claude'], {})).toEqual({});
  });

  it('forwards each non-claude key under the env var its CLI reads (codex -> OPENAI_API_KEY)', () => {
    const env = { CODEX_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['codex', 'cursor'], env)).toEqual({
      OPENAI_API_KEY: 'c-key',
      CURSOR_API_KEY: 'u-key',
    });
  });

  it('reads the codex key from OPENAI_API_KEY when CODEX_API_KEY is absent', () => {
    expect(providerSecrets(['codex'], { OPENAI_API_KEY: 'o-key' } as NodeJS.ProcessEnv)).toEqual({
      OPENAI_API_KEY: 'o-key',
    });
  });

  it('throws when a selected provider key is missing', () => {
    expect(() => providerSecrets(['codex'], {})).toThrow(/CODEX_API_KEY/);
  });

  it('deduplicates claude + codex, only forwarding codex', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(new Set(['claude', 'codex'] as const), env)).toEqual({ OPENAI_API_KEY: 'c-key' });
  });
});
