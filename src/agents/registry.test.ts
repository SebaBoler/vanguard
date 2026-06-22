import { describe, it, expect } from 'vitest';
import { isProviderName, makeProvider, providerSecrets, selectAgents, validateProviderChoice, PROVIDER_NAMES } from './registry.js';

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
    expect(makeProvider('zai').name).toBe('zai');
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

  it('forwards CODEX_AUTH_JSON and waives the API key (subscription mode)', () => {
    expect(providerSecrets(['codex'], { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' } as NodeJS.ProcessEnv)).toEqual({
      sandboxSecrets: { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' },
      proxySecrets: {},
    });
  });

  it('keeps CODEX_AUTH_JSON in the sandbox even under --llm-proxy (subscription is a sandbox credential)', () => {
    const env = { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['codex'], env, { proxyMode: true })).toEqual({
      sandboxSecrets: { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' },
      proxySecrets: {},
    });
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

describe('providerSecrets (zai)', () => {
  it('injects ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in normal mode (zai rides the Claude transport)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['zai'], env)).toEqual({
      sandboxSecrets: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/coding/paas/v4', ANTHROPIC_AUTH_TOKEN: 'z-key' },
      proxySecrets: {},
    });
  });

  it('withholds the z.ai key from the sandbox in proxy mode (no secondary sidecar; key comes via auth)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const { sandboxSecrets, proxySecrets } = providerSecrets(['zai'], env, { proxyMode: true });
    expect(sandboxSecrets).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(sandboxSecrets).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets).toEqual({});
  });

  it('throws when ZAI_API_KEY is missing (normal mode)', () => {
    expect(() => providerSecrets(['zai'], {})).toThrow(/ZAI_API_KEY/);
  });

  it('throws when ZAI_API_KEY is missing (proxy mode — key required either way)', () => {
    expect(() => providerSecrets(['zai'], {}, { proxyMode: true })).toThrow(/ZAI_API_KEY/);
  });
});

describe('selectAgents', () => {
  it('routes codex secrets to the sandbox in normal mode', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex' }, env);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.proxySecrets).toEqual({});
    expect(selected.injectAnthropicAuth).toBe(true);
  });

  it('holds the codex key in proxySecrets and out of the sandbox in proxy mode', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex' }, env, { proxyMode: true });
    expect(selected.secrets).not.toHaveProperty('OPENAI_API_KEY');
    expect(selected.proxySecrets.codex).toBe('c-key');
  });

  it('injects z.ai transport secrets and suppresses Anthropic auth for zai', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai' }, env);
    expect(selected.secrets).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/coding/paas/v4',
      ANTHROPIC_AUTH_TOKEN: 'z-key',
    });
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.proxySecrets).toEqual({});
  });

  it('keeps the z.ai key out of the sandbox in proxy mode (delivered to the primary sidecar via auth)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai' }, env, { proxyMode: true });
    expect(selected.secrets).toEqual({});
    expect(selected.proxySecrets).toEqual({});
    expect(selected.injectAnthropicAuth).toBe(false);
  });

  it('suppresses Anthropic auth when zai is only the REVIEWER (codex implements)', () => {
    const env = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env);
    // Without this, ANTHROPIC_API_KEY would be injected and the zai reviewer's Claude CLI would
    // prefer it over z.ai's ANTHROPIC_AUTH_TOKEN, hitting api.anthropic.com instead of z.ai.
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.secrets.ANTHROPIC_AUTH_TOKEN).toBe('z-key');
    expect(selected.secrets.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('suppresses Anthropic auth when zai IMPLEMENTS and cursor reviews', () => {
    const env = { CURSOR_API_KEY: 'u-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai', reviewProvider: 'cursor' }, env);
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.secrets.CURSOR_API_KEY).toBe('u-key');
    expect(selected.secrets.ANTHROPIC_AUTH_TOKEN).toBe('z-key');
  });

  it('rejects mixing claude and zai across stages (shared ANTHROPIC_* transport collides)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'claude', reviewProvider: 'zai' }, env)).toThrow(
      /cannot mix "claude" and "zai"/,
    );
    expect(() => selectAgents({ provider: 'zai', reviewProvider: 'claude' }, env)).toThrow(
      /cannot mix "claude" and "zai"/,
    );
    // default provider is claude, so an unspecified implementer + zai reviewer also collides
    expect(() => selectAgents({ reviewProvider: 'zai' }, env)).toThrow(/cannot mix "claude" and "zai"/);
  });

  it('rejects zai as reviewer-only under --llm-proxy (no primary sidecar; would misroute to Anthropic)', () => {
    const env = { CODEX_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
    expect(() => selectAgents({ provider: 'cursor', reviewProvider: 'zai' }, env, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
  });

  it('allows codex+zai cross-provider WITHOUT --llm-proxy (zai key rides the sandbox directly)', () => {
    const env = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.secrets.ANTHROPIC_AUTH_TOKEN).toBe('z-key');
    expect(selected.injectAnthropicAuth).toBe(false);
  });

  it('allows zai-implements + codex-reviews under --llm-proxy (zai owns the primary sidecar)', () => {
    const env = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai', reviewProvider: 'codex' }, env, { proxyMode: true });
    expect(selected.proxySecrets.codex).toBe('c-key'); // codex gets its secondary sidecar
    expect(selected.secrets).toEqual({}); // zai key withheld (primary sidecar via auth)
    expect(selected.injectAnthropicAuth).toBe(false);
  });
});

describe('validateProviderChoice', () => {
  it('throws on transport collision: claude + zai both own the anthropic transport', () => {
    expect(() => validateProviderChoice({ provider: 'claude', reviewProvider: 'zai' })).toThrow(
      /cannot mix "claude" and "zai"/,
    );
  });

  it('does NOT throw when codex implements and zai reviews (different transports)', () => {
    expect(() => validateProviderChoice({ provider: 'codex', reviewProvider: 'zai' })).not.toThrow();
  });

  it('throws when zai is reviewer-only under proxy mode (no primary sidecar for it)', () => {
    expect(() => validateProviderChoice({ provider: 'codex', reviewProvider: 'zai' }, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
  });

  it('selectAgents still throws on the same combos (behaviour unchanged)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'claude', reviewProvider: 'zai' }, env)).toThrow(
      /cannot mix "claude" and "zai"/,
    );
    const env2 = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env2, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
  });
});
