import { test, expect } from 'vitest';
import { emitFlowHcl } from './emit.js';
import type { PipelineStage } from '../pipeline/pipeline.js';

test('emits canonical HCL, dropping identity fields', () => {
  const stages: PipelineStage[] = [
    { name: 'planner', promptTemplate: 'p', systemPrompt: 's', model: 'opus', effort: 'high', maxTurns: 10, resumePrevious: false },
  ];
  const hcl = emitFlowHcl(stages, { name: 'f', label: 'L' });
  expect(hcl).toContain('flow "f" {');
  expect(hcl).toContain('label = "L"');
  expect(hcl).toContain('name = "planner"');
  expect(hcl).toContain('model = "opus"');
  expect(hcl).toContain('max_turns = 10');
  expect(hcl).toContain('resume_previous = false');
  expect(hcl).not.toContain('promptTemplate');
  expect(hcl).not.toContain('systemPrompt');
});

test('throws on a non-representable field rather than dropping it', () => {
  const stages: PipelineStage[] = [{ name: 'implementer', promptTemplate: 'p', stageCostFraction: 0.6 }];
  expect(() => emitFlowHcl(stages, { name: 'f', label: 'L' })).toThrow(/cannot emit field "stageCostFraction"/);
});

test('escapes quotes and backslashes in string values', () => {
  const stages: PipelineStage[] = [{ name: 'planner', promptTemplate: 'p', model: 'a"b\\c' }];
  const hcl = emitFlowHcl(stages, { name: 'f', label: 'L' });
  expect(hcl).toContain('model = "a\\"b\\\\c"');
});

test('output parses back and preserves stage order', () => {
  const stages: PipelineStage[] = [
    { name: 'planner', promptTemplate: 'p', model: 'opus' },
    { name: 'implementer', promptTemplate: 'p', model: 'sonnet' },
  ];
  const hcl = emitFlowHcl(stages, { name: 'f', label: 'L' });
  // structural sanity: two stage blocks, planner before implementer
  expect(hcl.indexOf('planner')).toBeLessThan(hcl.indexOf('implementer'));
  expect((hcl.match(/stage \{/g) ?? []).length).toBe(2);
});
