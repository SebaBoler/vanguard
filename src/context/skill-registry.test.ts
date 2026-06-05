import { describe, it, expect } from 'vitest';
import { SkillRegistry } from './skill-registry.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

describe('SkillRegistry', () => {
  it('copies registered skills into the sandbox', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyIn: async (h: string, s: string): Promise<void> => {
        calls.push([h, s]);
      },
    } as unknown as IsolatedSandboxProvider;
    await new SkillRegistry({ lint: '/host/skills/lint' }).inject(['lint'], sandbox);
    expect(calls).toEqual([['/host/skills/lint', '/workspace/.vanguard/skills/lint']]);
  });

  it('throws on unknown skill id', async () => {
    await expect(new SkillRegistry({}).inject(['nope'], {} as IsolatedSandboxProvider)).rejects.toThrow(/nope/);
  });
});
