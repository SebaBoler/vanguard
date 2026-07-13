import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { lowerFlow } from './lower.js';
import type { FlowDoc } from './types.js';

const REPO = fileURLToPath(new URL('./__fixtures__/repo', import.meta.url));

function doc(stages: FlowDoc['stages']): FlowDoc {
  return { name: 'f', label: 'l', stages, loops: [] };
}

test('resolves library stages, applies overrides, preserves order', async () => {
  const stages = await lowerFlow(
    doc([
      { name: 'planner', overrides: { model: 'sonnet', maxTurns: 3 } },
      { name: 'implementer', overrides: {} },
    ]),
    { repoPath: REPO },
  );
  expect(stages.map((s) => s.name)).toEqual(['planner', 'implementer']);
  expect(stages[0]?.model).toBe('sonnet'); // override wins over the library's 'opus'
  expect(stages[0]?.maxTurns).toBe(3);
  expect((stages[0]?.promptTemplate.length ?? 0) > 0).toBe(true); // identity from the library
});

test('resolves a ref stage to a custom TS export', async () => {
  const stages = await lowerFlow(doc([{ name: 'x', ref: 'scripts/custom.ts#myStage', overrides: {} }]), { repoPath: REPO });
  expect(stages[0]?.name).toBe('custom');
  expect(stages[0]?.promptTemplate).toMatch(/custom way/);
});

test('resolves a factory-form ref export', async () => {
  const stages = await lowerFlow(doc([{ name: 'x', ref: 'scripts/custom.ts#myFactoryStage', overrides: {} }]), { repoPath: REPO });
  expect(stages[0]?.name).toBe('custom-factory');
});

test('applies a provider override as an AgentProvider', async () => {
  const stages = await lowerFlow(doc([{ name: 'planner', overrides: { provider: 'codex' } }]), { repoPath: REPO });
  expect(stages[0]?.provider?.name).toBe('codex');
});

test('rejects an unknown stage with no ref', async () => {
  await expect(lowerFlow(doc([{ name: 'nope', overrides: {} }]), { repoPath: REPO })).rejects.toThrow(/unknown stage "nope"/);
});

test('rejects a ref that escapes .vanguard/', async () => {
  await expect(
    lowerFlow(doc([{ name: 'x', ref: '../../etc/passwd#x', overrides: {} }]), { repoPath: REPO }),
  ).rejects.toThrow(/outside|inside .vanguard/i);
});

test('rejects a ref whose export is missing', async () => {
  await expect(
    lowerFlow(doc([{ name: 'x', ref: 'scripts/custom.ts#nope', overrides: {} }]), { repoPath: REPO }),
  ).rejects.toThrow(/not found/);
});

test('rejects an unknown provider override', async () => {
  await expect(lowerFlow(doc([{ name: 'planner', overrides: { provider: 'bogus' } }]), { repoPath: REPO })).rejects.toThrow(
    /unknown provider "bogus"/,
  );
});
