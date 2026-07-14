import type { FlowDoc, StageDecl, StageOverrides } from '../../ipc';

/**
 * Pure state core of the visual flow editor (S5 §20). All real logic lives here, testable without
 * a DOM. Invariants: `doc.meta`, per-stage `meta`, and `doc.loops` pass through every transition
 * VERBATIM (the editor never interprets them — S5 Constraint 4); a failed save leaves `doc` and
 * `dirty` untouched (the user's edits must survive a rejection).
 */
export interface FlowEditorState {
  /** Target file (`<name>.hcl`). Set on load/create; null when nothing is open. */
  file: string | null;
  doc: FlowDoc | null;
  /** Raw file bytes on load, canonical HCL after a save, null for a not-yet-saved flow. */
  source: string | null;
  dirty: boolean;
  /** Selected stage index into doc.stages, or null. */
  selected: number | null;
  /** Load/save error shown inline; cleared by the next successful action. */
  error: string | null;
}

export const initialFlowEditor: FlowEditorState = {
  file: null,
  doc: null,
  source: null,
  dirty: false,
  selected: null,
  error: null,
};

export type FlowEditorAction =
  | { type: 'reset' }
  | { type: 'loaded'; file: string; doc: FlowDoc; source: string }
  | { type: 'loadFailed'; file: string; error: string }
  /** New in-memory flow: label = name, no stages yet (Save stays disabled until one is added). */
  | { type: 'created'; name: string }
  | { type: 'select'; index: number }
  | { type: 'addStage'; name: string; ref?: string }
  | { type: 'removeStage'; index: number }
  | { type: 'moveStage'; from: number; to: number }
  | { type: 'setStageName'; index: number; name: string }
  /** Empty string clears the ref (stage falls back to a library name). */
  | { type: 'setRef'; index: number; ref: string }
  | { type: 'setOverride'; index: number; key: keyof StageOverrides; value: StageOverrides[keyof StageOverrides] }
  /** `savedDoc` = the exact doc object the save shipped — dirty clears only if it is still current. */
  | { type: 'saveOk'; source: string; savedDoc: FlowDoc }
  | { type: 'saveFailed'; error: string };

export function flowEditorReducer(state: FlowEditorState, action: FlowEditorAction): FlowEditorState {
  switch (action.type) {
    case 'reset':
      return initialFlowEditor;
    case 'loaded':
      return { file: action.file, doc: action.doc, source: action.source, dirty: false, selected: null, error: null };
    case 'loadFailed':
      return { ...initialFlowEditor, file: action.file, error: action.error };
    case 'created':
      return {
        file: `${action.name}.hcl`,
        doc: { name: action.name, label: action.name, stages: [], loops: [] },
        source: null,
        dirty: true,
        selected: null,
        error: null,
      };
    case 'select':
      return state.doc === null || action.index < 0 || action.index >= state.doc.stages.length
        ? state
        : { ...state, selected: action.index };
    case 'addStage': {
      if (state.doc === null) return state;
      const stage: StageDecl = { name: action.name, ...(action.ref !== undefined ? { ref: action.ref } : {}), overrides: {} };
      const stages = [...state.doc.stages, stage];
      return { ...state, doc: { ...state.doc, stages }, dirty: true, selected: stages.length - 1, error: null };
    }
    case 'removeStage': {
      if (state.doc === null || action.index < 0 || action.index >= state.doc.stages.length) return state;
      const stages = state.doc.stages.filter((_, i) => i !== action.index);
      const selected =
        state.selected === null ? null : state.selected === action.index ? null : state.selected > action.index ? state.selected - 1 : state.selected;
      return { ...state, doc: { ...state.doc, stages }, dirty: true, selected, error: null };
    }
    case 'moveStage': {
      if (state.doc === null) return state;
      const { from } = action;
      const to = Math.max(0, Math.min(action.to, state.doc.stages.length - 1));
      if (from === to || from < 0 || from >= state.doc.stages.length) return state;
      const stages = [...state.doc.stages];
      const [moved] = stages.splice(from, 1);
      stages.splice(to, 0, moved!);
      // Remap so the selection keeps aiming at the SAME stage: any block can be reordered while
      // another is selected (◀/▶ live on every block) — without the crossing shifts the inspector
      // would silently edit whichever stage slid into the old index.
      const sel = state.selected;
      const selected =
        sel === null ? null
        : sel === from ? to
        : from < sel && to >= sel ? sel - 1
        : from > sel && to <= sel ? sel + 1
        : sel;
      return { ...state, doc: { ...state.doc, stages }, dirty: true, selected, error: null };
    }
    case 'setStageName':
      return updateStage(state, action.index, (s) => ({ ...s, name: action.name }));
    case 'setRef':
      return updateStage(state, action.index, (s) => {
        const { ref: _dropped, ...rest } = s;
        return action.ref === '' ? rest : { ...rest, ref: action.ref };
      });
    case 'setOverride':
      return updateStage(state, action.index, (s) => {
        const { [action.key]: _dropped, ...rest } = s.overrides;
        return { ...s, overrides: action.value === undefined ? rest : { ...rest, [action.key]: action.value } };
      });
    case 'saveOk':
      // Reference-compare against the shipped snapshot: an edit made while the save was in flight
      // lives in state.doc but NOT on disk — clearing dirty would disable Save and let the next
      // flow switch discard it without a confirm. `source` still updates: it reflects what IS on
      // disk now (the old snapshot's canonical form). Every reducer edit builds a new doc object,
      // so identity is exactly "unchanged since save".
      return { ...state, source: action.source, dirty: state.doc !== action.savedDoc, error: null };
    case 'saveFailed':
      // doc + dirty untouched: the edits must survive a rejection (S5 §19).
      return { ...state, error: action.error };
  }
}

function updateStage(state: FlowEditorState, index: number, fn: (s: StageDecl) => StageDecl): FlowEditorState {
  if (state.doc === null || index < 0 || index >= state.doc.stages.length) return state;
  const stages = state.doc.stages.map((s, i) => (i === index ? fn(s) : s));
  return { ...state, doc: { ...state.doc, stages }, dirty: true, error: null };
}

/** The flow-name grammar, from the generated wire contract (S7 — no more mirror). */
export { FLOW_NAME_RE } from '../../wire';
