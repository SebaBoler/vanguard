import { describe, it, expect } from 'vitest';
import { isProviderName, makeProvider, providerSecrets, selectAgents, PROVIDER_NAMES } from './registry.js';

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
  it('returns empty buckets for claude (auth handled separately)', () => {
    expect(providerSecrets(['claude'], {})).toEqual({ sandboxSecrets: {}, proxySecrets: {} });
  });

  it('forwards each non-claude key under the env var its CLI reads (codex -> OPENAI_API_KEY)', () => {
    const env = { CODEX_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['codex', 'cursor'], env)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key' },
      proxySecrets: {},
    });
  });

  it('reads the codex key from OPENAI_API_KEY when CODEX_API_KEY is absent', () => {
    expect(providerSecrets(['codex'], { OPENAI_API_KEY: 'o-key' } as NodeJS.ProcessEnv)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'o-key' },
      proxySecrets: {},
    });
  });

  it('throws when a selected provider key is missing (normal mode)', () => {
    expect(() => providerSecrets(['codex'], {})).toThrow(/CODEX_API_KEY/);
  });

  it('throws when a selected provider key is missing (proxy mode — key required either way)', () => {
    expect(() => providerSecrets(['codex'], {}, { proxyMode: true })).toThrow(/CODEX_API_KEY/);
  });

  it('deduplicates claude + codex, only forwarding codex', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(new Set(['claude', 'codex'] as const), env)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'c-key' },
      proxySecrets: {},
    });
  });

  it('proxy mode holds the codex key back from the sandbox', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const { sandboxSecrets, proxySecrets } = providerSecrets(['codex'], env, { proxyMode: true });
    expect(sandboxSecrets).not.toHaveProperty('OPENAI_API_KEY');
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets.codex).toBe('c-key');
  });

  it('proxy mode keeps cursor sandbox-injected (no proxyKey, out of scope for v1.4)', () => {
    const env = { CURSOR_API_KEY: 'u-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['cursor'], env, { proxyMode: true })).toEqual({
      sandboxSecrets: { CURSOR_API_KEY: 'u-key' },
      proxySecrets: {},
    });
  });
});

describe('selectAgents', () => {
  it('routes codex secrets to the sandbox in normal mode', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex' }, env);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.proxySecrets).toEqual({});
  });

  it('holds the codex key in proxySecrets and out of the sandbox in proxy mode', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex' }, env, { proxyMode: true });
    expect(selected.secrets).not.toHaveProperty('OPENAI_API_KEY');
    expect(selected.proxySecrets.codex).toBe('c-key');
  });
});
