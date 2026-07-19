import { test, expect } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    /[Uu]nknown provider "bogus"/,
  );
});

// S6 gate 4: a stage pin only swaps the agent — the sandbox transport env stays the RUN provider's.
// A transport-owning pin (zai, openrouter, meridian, customs) would silently hit the wrong endpoint
// (latent trap for `provider = "zai"` before S6), so lowering rejects it loudly.
test('rejects a stage pinned to a transport-owning provider (zai) with a named error', async () => {
  await expect(lowerFlow(doc([{ name: 'planner', overrides: { provider: 'zai' } }]), { repoPath: REPO })).rejects.toThrow(
    /stage "planner" pins provider "zai".*owns the Anthropic transport/s,
  );
});

test('rejects a stage pinned to a custom provider; allows a cross-slot pin (codex)', async () => {
  const customs = [
    { index: 0, name: 'my-proxy', spec: { name: 'my-proxy', baseUrl: 'https://llm.example.com', keyEnv: 'K' } },
  ];
  await expect(
    lowerFlow(doc([{ name: 'planner', overrides: { provider: 'my-proxy' } }]), { repoPath: REPO, customProviders: customs }),
  ).rejects.toThrow(/owns the Anthropic transport/);
  const stages = await lowerFlow(doc([{ name: 'planner', overrides: { provider: 'codex' } }]), { repoPath: REPO });
  expect(stages[0]?.provider?.name).toBe('codex');
});

test('re-imports an edited ref module (mtime cache-bust) — the long-lived sidecar must not run stale code', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'vg-ref-'));
  try {
    const dir = join(repo, '.vanguard', 'scripts');
    await mkdir(dir, { recursive: true });
    const mod = join(dir, 'gen.mjs');
    await writeFile(mod, "export const stage = { name: 'gen', promptTemplate: 'v1' };\n", 'utf8');
    const first = await lowerFlow(doc([{ name: 'x', ref: 'scripts/gen.mjs#stage', overrides: {} }]), { repoPath: repo });
    expect(first[0]?.promptTemplate).toBe('v1');

    await writeFile(mod, "export const stage = { name: 'gen', promptTemplate: 'v2' };\n", 'utf8');
    // guarantee a distinct integer mtime even on coarse filesystem clocks
    await utimes(mod, new Date(), new Date(Date.now() + 5000));
    const second = await lowerFlow(doc([{ name: 'x', ref: 'scripts/gen.mjs#stage', overrides: {} }]), { repoPath: repo });
    expect(second[0]?.promptTemplate).toBe('v2');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('rejects a prototype-key stage name instead of lowering Object.prototype into a stage', async () => {
  await expect(lowerFlow(doc([{ name: 'toString', overrides: {} }]), { repoPath: REPO })).rejects.toThrow(
    /unknown stage "toString"/,
  );
});
