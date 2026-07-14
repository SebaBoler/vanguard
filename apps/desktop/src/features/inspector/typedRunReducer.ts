// RunEvent comes from the generated wire contract (S7 — no more hand-mirror). Re-exported because
// Inspector imports it from here.
import type { RunEvent } from '../../wire';
export type { RunEvent } from '../../wire';

type StagePhase = 'pending' | 'running' | 'done' | 'failed';

export interface TypedRunState {
  runId?: string;
  taskId?: string;
  flow?: string;
  provider?: string;
  stages: string[];
  stageState: Record<number, StagePhase>;
  usdSpent: number;
  terminal?: { kind: 'success' | 'no-changes' | 'secret-blocked' | 'error' | 'cancelled'; prUrl?: string; message?: string };
}

/** `run-accepted` is Rust-minted (sidecar.rs) and never core-emitted, so it is a DESKTOP extension
 *  of the wire union, not part of it. */
export type AppRunEvent = RunEvent | { type: 'run-accepted' };
type Incoming = AppRunEvent;

export function initialTypedRun(): TypedRunState {
  return { stages: [], stageState: {}, usdSpent: 0 };
}

/** Fold one `{runId, event}` payload, last-write-wins per key. Foreign runIds are dropped. */
export function reduceTypedRun(state: TypedRunState, payload: { runId: string; event: Incoming }): TypedRunState {
  // Adopt the first runId; thereafter drop anything that isn't ours.
  if (state.runId !== undefined && payload.runId !== state.runId) return state;
  const runId = state.runId ?? payload.runId;
  const e = payload.event;
  switch (e.type) {
    case 'run-accepted':
      return { ...state, runId };
    case 'run-start':
      return { ...state, runId, taskId: e.taskId, flow: e.flow, provider: e.provider, stages: e.stages };
    case 'stage-start':
      return { ...state, runId, stageState: { ...state.stageState, [e.index]: 'running' } };
    case 'stage-end':
      return { ...state, runId, stageState: { ...state.stageState, [e.index]: e.outcome === 'completed' ? 'done' : 'failed' } };
    case 'cost':
      return { ...state, runId, usdSpent: e.usdSpent }; // cumulative — last wins, never sum
    case 'run-end':
      return {
        ...state,
        runId,
        terminal:
          e.prUrl !== undefined
            ? { kind: 'success', prUrl: e.prUrl }
            : e.secretBlocked === true
              ? { kind: 'secret-blocked' }
              : { kind: 'no-changes' },
      };
    case 'run-error':
      return { ...state, runId, terminal: { kind: 'error', message: e.message } };
    case 'run-cancelled':
      return { ...state, runId, terminal: { kind: 'cancelled' } };
    default:
      return state;
  }
}
