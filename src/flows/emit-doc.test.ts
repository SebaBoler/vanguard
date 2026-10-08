import { test, expect } from 'vitest';
import { emitFlowDoc } from './emit-doc.js';
import { parseFlowHcl } from './parse.js';
import type { FlowDoc } from './types.js';

const doc = (over: Partial<FlowDoc>): FlowDoc => ({
  name: 'f',
  label: 'L',
  stages: [{ name: 'planner', overrides: {} }],
  loops: [],
  ...over,
});

// The editor's correctness spine (S5 AC1): emit → parse must reproduce the doc exactly.
test.each<[string, FlowDoc]>([
  ['minimal', doc({})],
  [
    'every override key',
    doc({
      stages: [
        { name: 'planner', overrides: { model: 'gpt-5', effort: 'xhigh', maxTurns: 7, provider: 'codex', resumePrevious: false } },
        { name: 'implementer', overrides: { effort: 'max', resumePrevious: true } },
      ],
    }),
  ],
  ['a ref stage', doc({ stages: [{ name: 'custom', ref: 'scripts/custom.ts#myStage', overrides: { model: 'opus' } }] })],
  [
    'stage meta with nested/array/null values and a non-identifier key',
    doc({
      stages: [
        {
          name: 'planner',
          overrides: {},
          meta: { note: 'hi', 'a b': 1, nested: { x: 1 }, arr: ['a', 2, true], nothing: null, blocks: [{ deep: 'v' }] },
        },
      ],
    }),
  ],
  ['flow meta', doc({ meta: { owner: 'pawel', pinned: true } })],
  ['empty meta object', doc({ meta: {} })],
  ['loops after stages', doc({ loops: [{ stages: ['planner', 'reviewer'], until: 'reviewer_pass', max: 3 }] })],
  ['quoting-hostile strings', doc({ label: 'a"b\\c\nd\te', stages: [{ name: 'planner', overrides: { model: 'm"x\\y' } }] })],
])('round-trips %s', async (_label, fixture) => {
  expect(await parseFlowHcl(emitFlowDoc(fixture))).toEqual(fixture);
});

test('is a fixed point: emitting the parsed output reproduces the same bytes', async () => {
  const fixture = doc({
    meta: { z: 1, a: { 'k k': [1, null] } },
    stages: [{ name: 'planner', overrides: { model: 'opus' }, meta: { blocks: [{ deep: 'v' }] } }],
  });
  const once = emitFlowDoc(fixture);
  expect(emitFlowDoc(await parseFlowHcl(once))).toBe(once);
});

test('throws on template syntax in strings — an unbalanced ${ would emit unparseable HCL', () => {
  expect(() => emitFlowDoc(doc({ label: 'oops ${' }))).toThrow(/template syntax/);
  expect(() => emitFlowDoc(doc({ stages: [{ name: 'planner', overrides: { model: '%{ nope' } }] }))).toThrow(/template syntax/);
  expect(() => emitFlowDoc(doc({ meta: { k: 'has ${interp}' } }))).toThrow(/template syntax/);
});

test('throws on meta values with no HCL representation, never a silent drop', () => {
  expect(() => emitFlowDoc(doc({ meta: { bad: undefined } }))).toThrow(/cannot emit/);
  expect(() => emitFlowDoc(doc({ meta: { bad: Number.NaN } }))).toThrow(/non-finite/);
  expect(() => emitFlowDoc(doc({ meta: { bad: () => 'x' } as unknown as Record<string, unknown> }))).toThrow(/cannot emit/);
});
