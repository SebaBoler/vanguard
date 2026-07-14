import { test, expect } from 'vitest';
import { STAGE_LIBRARY } from './library.js';
import { implementReviewSimplifyStages, planImplementAdversaryStages } from '../pipeline/pipeline.js';

const PALETTE = ['planner', 'implementer', 'adversary', 'repairer', 'reviewer', 'simplifier'];

test('library exposes the palette stages resolving to real records', () => {
  for (const name of PALETTE) {
    const rec = STAGE_LIBRARY[name];
    expect(rec?.name).toBe(name);
    expect((rec?.promptTemplate.length ?? 0) > 0).toBe(true);
    expect(typeof rec?.systemPrompt).toBe('string'); // .map-applied on the default builder — must survive extraction
  }
});

test('records match their source builders verbatim (drift guard)', () => {
  const adversary = new Map(planImplementAdversaryStages().map((s) => [s.name, s]));
  const defaults = new Map(implementReviewSimplifyStages().map((s) => [s.name, s]));
  for (const name of ['planner', 'implementer', 'adversary', 'repairer']) {
    expect(STAGE_LIBRARY[name]).toEqual(adversary.get(name));
  }
  for (const name of ['reviewer', 'simplifier']) {
    expect(STAGE_LIBRARY[name]).toEqual(defaults.get(name));
  }
});

test('exactly the palette names — a new entry must name its source builder in library.ts', () => {
  expect(Object.keys(STAGE_LIBRARY).sort()).toEqual([...PALETTE].sort());
});
