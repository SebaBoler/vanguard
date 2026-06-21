import { describe, it, expect } from 'vitest';
import { QuotaRoutingProvider } from './quota-routing.js';
import type { ModelEntry, BucketCheck } from './quota.js';
import type { AgentProvider, AgentRunInput } from './provider.js';

const MODELS: ModelEntry[] = [
  { key: 'glm', bucket: 'zai', env: { A: 'z' } },
  { key: 'sonnet', bucket: 'claude', env: { A: 'c' } },
];

const MODELS_WITH_SECRETS: ModelEntry[] = [
  { key: 'glm', bucket: 'zai', env: { A: 'z' }, secrets: { ENTRY_KEY: 'entry-val' } },
  { key: 'sonnet', bucket: 'claude', env: { A: 'c' } },
];

function fakeDelegate() {
  const calls: Array<{ model: string | undefined; env: Record<string, string> | undefined; secrets: Record<string, string> | undefined }> = [];
  const provider: AgentProvider = {
    name: 'fake',
    async *run(input: AgentRunInput) {
      calls.push({ model: input.model, env: input.env, secrets: input.secrets });
      yield { text: 't' };
      return { finalText: 'ok', turns: 1 };
    },
  };
  return { provider, calls };
}

const up: BucketCheck = { available: async () => true };

describe('QuotaRoutingProvider', () => {
  it('routes to the primary and overlays its env', async () => {
    const { provider, calls } = fakeDelegate();
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: up, claude: up },
    });
    const g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* drain */ }
    expect(calls[0]).toMatchObject({ model: 'glm', env: { A: 'z' } });
  });

  it('overlays entry.secrets onto input.secrets (entry wins, pre-existing keys preserved)', async () => {
    const { provider, calls } = fakeDelegate();
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS_WITH_SECRETS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: up, claude: up },
    });
    // input already carries a secret; entry should overlay its own key on top
    const g = r.run({ model: 'glm', secrets: { PRE_KEY: 'pre-val' } } as unknown as AgentRunInput);
    while (!(await g.next()).done) { /* drain */ }
    expect(calls[0]?.secrets).toEqual({ PRE_KEY: 'pre-val', ENTRY_KEY: 'entry-val' });
  });

  it('is sticky: once zai floors, later stages stay on claude even if zai recovers', async () => {
    const { provider, calls } = fakeDelegate();
    let zaiUp = false;
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: { available: async () => zaiUp }, claude: up },
    });
    let g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* stage 1: zai down -> claude */ }
    zaiUp = true; // "recovers"
    g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* stage 2: still claude */ }
    expect(calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
  });

  it('emits a burn line per turn to the debug sink', async () => {
    const { provider } = fakeDelegate();
    const lines: string[] = [];
    const r = new QuotaRoutingProvider({
      delegate: provider, models: MODELS, chain: ['glm', 'sonnet'], cacheDir: '/tmp/none',
      checks: { zai: up, claude: up }, debug: (l) => lines.push(l),
    });
    const g = r.run({ model: 'glm' } as AgentRunInput);
    while (!(await g.next()).done) { /* drain */ }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[quota]');
  });
});
