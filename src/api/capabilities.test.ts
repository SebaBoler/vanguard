import { describe, expect, it } from 'vitest';
import { capabilities, FLOWS } from './capabilities.js';
import { PROVIDER_NAMES } from '../agents/registry.js';

describe('capabilities', () => {
  it('lists every registered provider', () => {
    expect(capabilities().providers).toEqual([...PROVIDER_NAMES]);
  });

  it('lists flows including the default, each with a label', () => {
    const names = capabilities().flows.map((f) => f.name);
    expect(names).toContain('default');
    expect(capabilities().flows.every((f) => f.label.length > 0)).toBe(true);
  });

  it('exposes the three task transports and sane defaults', () => {
    const caps = capabilities();
    expect(caps.transports).toEqual(['github', 'gitlab', 'linear']);
    expect(caps.defaults).toEqual({ provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' });
  });

  it('every FLOWS entry builds a non-empty stage array', () => {
    for (const [, flow] of Object.entries(FLOWS)) {
      expect(flow.build().length).toBeGreaterThan(0);
    }
  });
});
