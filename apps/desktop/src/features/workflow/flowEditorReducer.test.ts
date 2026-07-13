import { describe, expect, it, test } from 'vitest';
import { flowEditorReducer, initialFlowEditor, FLOW_NAME_RE, type FlowEditorAction, type FlowEditorState } from './flowEditorReducer';
import type { FlowDoc } from '../../ipc';

const DOC: FlowDoc = {
  name: 'my-flow',
  label: 'Mine',
  stages: [
    { name: 'planner', overrides: { model: 'opus' } },
    { name: 'implementer', overrides: {} },
    { name: 'reviewer', overrides: {}, meta: { note: 'kept' } },
  ],
  loops: [{ stages: ['planner', 'reviewer'], until: 'reviewer_pass', max: 3 }],
  meta: { owner: 'pawel' },
};

const loaded = (): FlowEditorState =>
  flowEditorReducer(initialFlowEditor, { type: 'loaded', file: 'my-flow.hcl', doc: DOC, source: 'raw' });

const apply = (state: FlowEditorState, ...actions: FlowEditorAction[]): FlowEditorState =>
  actions.reduce(flowEditorReducer, state);

describe('flowEditorReducer', () => {
  it('loaded resets dirty/selection and holds the raw source', () => {
    const s = loaded();
    expect(s).toMatchObject({ file: 'my-flow.hcl', doc: DOC, source: 'raw', dirty: false, selected: null, error: null });
  });

  it('meta and loops pass through a full load→edit→save cycle VERBATIM', () => {
    const s = apply(
      loaded(),
      { type: 'addStage', name: 'simplifier' },
      { type: 'moveStage', from: 3, to: 0 },
      { type: 'setOverride', index: 1, key: 'effort', value: 'high' },
      { type: 'removeStage', index: 0 },
      { type: 'saveOk', source: 'canonical' },
    );
    expect(s.doc?.meta).toEqual({ owner: 'pawel' });
    expect(s.doc?.loops).toEqual(DOC.loops);
    expect(s.doc?.stages.find((st) => st.name === 'reviewer')?.meta).toEqual({ note: 'kept' });
    expect(s).toMatchObject({ dirty: false, source: 'canonical' });
  });

  it('saveFailed leaves doc and dirty untouched — edits must survive a rejection', () => {
    const edited = apply(loaded(), { type: 'addStage', name: 'simplifier' });
    const failed = flowEditorReducer(edited, { type: 'saveFailed', error: 'flow "my-flow" is already declared in other.hcl' });
    expect(failed.doc).toEqual(edited.doc);
    expect(failed.dirty).toBe(true);
    expect(failed.error).toMatch(/already declared/);
  });

  it('created builds an empty unsaved doc (Save stays disabled until a stage exists)', () => {
    const s = flowEditorReducer(initialFlowEditor, { type: 'created', name: 'fresh' });
    expect(s).toMatchObject({
      file: 'fresh.hcl',
      doc: { name: 'fresh', label: 'fresh', stages: [], loops: [] },
      source: null,
      dirty: true,
    });
  });

  it('addStage appends and selects; removeStage drops and re-aims the selection', () => {
    let s = apply(loaded(), { type: 'addStage', name: 'simplifier' });
    expect(s.doc?.stages.map((st) => st.name)).toEqual(['planner', 'implementer', 'reviewer', 'simplifier']);
    expect(s.selected).toBe(3);

    s = apply(s, { type: 'select', index: 2 }, { type: 'removeStage', index: 0 });
    expect(s.doc?.stages.map((st) => st.name)).toEqual(['implementer', 'reviewer', 'simplifier']);
    expect(s.selected).toBe(1); // shifted left past the removal

    s = apply(s, { type: 'removeStage', index: 1 });
    expect(s.selected).toBeNull(); // the selected stage itself was removed
  });

  it('moveStage reorders, clamps out-of-range targets, and follows the selection', () => {
    let s = apply(loaded(), { type: 'select', index: 0 }, { type: 'moveStage', from: 0, to: 2 });
    expect(s.doc?.stages.map((st) => st.name)).toEqual(['implementer', 'reviewer', 'planner']);
    expect(s.selected).toBe(2);

    const clamped = flowEditorReducer(s, { type: 'moveStage', from: 2, to: 99 });
    expect(clamped.doc?.stages.map((st) => st.name)).toEqual(['implementer', 'reviewer', 'planner']); // 99 clamps to last — no-op

    expect(flowEditorReducer(s, { type: 'moveStage', from: -1, to: 0 })).toBe(s);
  });

  it('setOverride sets and (with undefined) deletes a key; other overrides survive', () => {
    let s = apply(loaded(), { type: 'setOverride', index: 0, key: 'maxTurns', value: 9 });
    expect(s.doc?.stages[0]?.overrides).toEqual({ model: 'opus', maxTurns: 9 });
    s = apply(s, { type: 'setOverride', index: 0, key: 'model', value: undefined });
    expect(s.doc?.stages[0]?.overrides).toEqual({ maxTurns: 9 });
  });

  it('setRef sets a ref and clears it on empty string (no dangling ref key)', () => {
    let s = apply(loaded(), { type: 'setRef', index: 1, ref: 'scripts/x.ts#stage' });
    expect(s.doc?.stages[1]?.ref).toBe('scripts/x.ts#stage');
    s = apply(s, { type: 'setRef', index: 1, ref: '' });
    expect('ref' in (s.doc?.stages[1] ?? {})).toBe(false);
  });

  it('setStageName renames without touching overrides or meta', () => {
    const s = apply(loaded(), { type: 'setStageName', index: 2, name: 'simplifier' });
    expect(s.doc?.stages[2]).toEqual({ name: 'simplifier', overrides: {}, meta: { note: 'kept' } });
  });

  it('reset and loadFailed clear the editing state', () => {
    expect(flowEditorReducer(loaded(), { type: 'reset' })).toEqual(initialFlowEditor);
    const failed = flowEditorReducer(loaded(), { type: 'loadFailed', file: 'broken.hcl', error: 'nope' });
    expect(failed).toMatchObject({ file: 'broken.hcl', doc: null, error: 'nope', dirty: false });
  });

  it('edits on nothing are no-ops (guards, not crashes)', () => {
    for (const action of [
      { type: 'select', index: 0 },
      { type: 'addStage', name: 'planner' },
      { type: 'removeStage', index: 0 },
      { type: 'moveStage', from: 0, to: 1 },
      { type: 'setOverride', index: 0, key: 'model', value: 'x' },
    ] as const) {
      expect(flowEditorReducer(initialFlowEditor, action as FlowEditorAction)).toEqual(initialFlowEditor);
    }
  });
});

test('FLOW_NAME_RE mirrors the core grammar', () => {
  for (const good of ['my-flow', 'a', '0x', 'a.b_c-d']) expect(FLOW_NAME_RE.test(good)).toBe(true);
  for (const bad of ['My-Flow', 'a b', '-lead', '', 'a/b']) expect(FLOW_NAME_RE.test(bad)).toBe(false);
});
