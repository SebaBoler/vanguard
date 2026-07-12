import { test, expect } from 'vitest';
import { STAGE_LIBRARY } from './library.js';
import { planImplementAdversaryStages } from '../pipeline/pipeline.js';

test('library exposes Flow B stages resolving to real records', () => {
  for (const name of ['planner', 'implementer', 'adversary', 'repairer']) {
    const rec = STAGE_LIBRARY[name]?.();
    expect(rec?.name).toBe(name);
    expect((rec?.promptTemplate.length ?? 0) > 0).toBe(true);
  }
});

test('library records match the source builder verbatim (drift guard)', () => {
  const byName = new Map(planImplementAdversaryStages().map((s) => [s.name, s]));
  for (const [name, factory] of Object.entries(STAGE_LIBRARY)) {
    expect(factory()).toEqual(byName.get(name));
  }
});

test('each factory returns a fresh copy (no shared mutable record)', () => {
  const a = STAGE_LIBRARY['planner']!();
  const b = STAGE_LIBRARY['planner']!();
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});
