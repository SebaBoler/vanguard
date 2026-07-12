import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planImplementAdversaryStages, type PipelineStage } from '../pipeline/pipeline.js';
import { FLOWS } from '../api/capabilities.js';
import { emitFlowHcl } from './emit.js';
import { parseFlowHcl } from './parse.js';
import { lowerFlow } from './lower.js';

const FLOW_B_LABEL = FLOWS['flow-b']!.label;

const KEYS = ['name', 'model', 'effort', 'maxTurns', 'resumePrevious', 'promptTemplate', 'systemPrompt'] as const;
const pick = (s: PipelineStage): Record<string, unknown> =>
  Object.fromEntries(KEYS.map((k) => [k, (s as unknown as Record<string, unknown>)[k]]));

test('Flow B round-trips through emit → parse → lower', async () => {
  const src = planImplementAdversaryStages();
  const hcl = emitFlowHcl(src, { name: 'flow-b', label: FLOW_B_LABEL });
  const lowered = await lowerFlow(await parseFlowHcl(hcl), { repoPath: '/nonexistent' });
  expect(lowered.map(pick)).toEqual(src.map(pick));
});

test('checked-in flow-b.hcl equals the emitter output (codegen drift guard)', () => {
  const disk = readFileSync(fileURLToPath(new URL('./flow-b.hcl', import.meta.url)), 'utf8');
  const emitted = emitFlowHcl(planImplementAdversaryStages(), { name: 'flow-b', label: FLOW_B_LABEL });
  expect(disk.trimEnd()).toBe(emitted.trimEnd());
});

test('a provider override + xhigh effort round-trip through emit → parse → lower', async () => {
  // emit reads only provider.name; a partial object suffices for the round-trip.
  const stages: PipelineStage[] = [
    {
      name: 'planner',
      promptTemplate: 'p',
      model: 'gpt-5',
      effort: 'xhigh',
      provider: { name: 'codex' } as unknown as NonNullable<PipelineStage['provider']>,
    },
  ];
  const hcl = emitFlowHcl(stages, { name: 'f', label: 'L' });
  const lowered = await lowerFlow(await parseFlowHcl(hcl), { repoPath: '/nonexistent' });
  expect(lowered[0]?.provider?.name).toBe('codex');
  expect(lowered[0]?.effort).toBe('xhigh');
});

test('flow-a.hcl parses (loop + stages) and re-emits its stages', async () => {
  const src = readFileSync(fileURLToPath(new URL('./__fixtures__/flow-a.hcl', import.meta.url)), 'utf8');
  const doc = await parseFlowHcl(src);
  expect(doc.loops[0]).toEqual({ stages: ['planner', 'reviewer'], until: 'reviewer_pass', max: 3 });
  expect(doc.stages.map((s) => s.name)).toEqual(['implementer', 'adversary', 'repairer']);
  // its non-loop stages re-emit without loss (library-shaped)
  const stages = await lowerFlow({ ...doc, loops: [] }, { repoPath: '/nonexistent' });
  const hcl = emitFlowHcl(stages, { name: doc.name, label: doc.label });
  expect((await parseFlowHcl(hcl)).stages.map((s) => s.name)).toEqual(['implementer', 'adversary', 'repairer']);
});
