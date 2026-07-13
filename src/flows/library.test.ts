import { test, expect } from 'vitest';
import { STAGE_LIBRARY } from './library.js';
import { planImplementAdversaryStages } from '../pipeline/pipeline.js';

test('library exposes Flow B stages resolving to real records', () => {
  for (const name of ['planner', 'implementer', 'adversary', 'repairer']) {
    const rec = STAGE_LIBRARY[name];
    expect(rec?.name).toBe(name);
    expect((rec?.promptTemplate.length ?? 0) > 0).toBe(true);
  }
});

test('library records match the source builder verbatim (drift guard)', () => {
  const byName = new Map(planImplementAdversaryStages().map((s) => [s.name, s]));
  for (const [name, record] of Object.entries(STAGE_LIBRARY)) {
    expect(record).toEqual(byName.get(name));
  }
});
