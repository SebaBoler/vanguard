import { describe, it, expect } from 'vitest';
import { agentFamily, agentFamilyIsExplicit } from './provider.js';
import { PROVIDER_NAMES, makeProvider } from './registry.js';

describe('agentFamily', () => {
  it('maps every Claude-CLI adapter, built-in or custom, to claude-cli', () => {
    for (const name of ['claude-code', 'zai', 'openrouter', 'meridian', 'custom:acme-gateway']) {
      expect(agentFamily(name)).toBe('claude-cli');
    }
  });
  it('keeps codex, cursor and pi distinct', () => {
    expect(agentFamily('codex')).toBe('codex');
    expect(agentFamily('cursor')).toBe('cursor');
    expect(agentFamily('pi')).toBe('pi');
  });
  it('treats an absent name as claude-cli (the default adapter)', () => {
    expect(agentFamily(undefined)).toBe('claude-cli');
  });
});

describe('agentFamily table hygiene', () => {
  it('ignores Object.prototype keys instead of returning an inherited value', () => {
    for (const name of ['toString', 'constructor', 'valueOf', '__proto__']) {
      expect(agentFamily(name)).toBe('claude-cli');
    }
  });
  it('names every built-in adapter explicitly — a new provider without a row fails here, not silently at runtime', () => {
    for (const providerName of PROVIDER_NAMES) {
      expect(agentFamilyIsExplicit(makeProvider(providerName).name)).toBe(true);
    }
    expect(agentFamilyIsExplicit('custom:acme-gateway')).toBe(false);
  });
});
