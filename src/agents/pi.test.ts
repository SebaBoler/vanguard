import { describe, it, expect } from 'vitest';
import { PiProvider } from './pi.js';
import type { AgentRunInput } from './provider.js';

describe('PiProvider', () => {
  it('throws NotImplementedError when its generator is iterated', async () => {
    const gen = new PiProvider().run({} as AgentRunInput);
    await expect(gen.next()).rejects.toThrow(/Phase 2/);
  });
});
