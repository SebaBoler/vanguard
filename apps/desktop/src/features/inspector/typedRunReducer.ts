// Mirrors the core `RunEvent` union (src/pipeline/events.ts) + the Rust-only `run-accepted`. The
// desktop mirrors core wire types locally (like Capabilities/CreateRunParams in ipc.ts) rather than
// importing across the app boundary. Keep in sync with events.ts on change.
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: string[] }
  | { type: 'stage-start'; name: string; index: number; of: number }
  | { type: 'stage-end'; name: string; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean }
  | { type: 'run-error'; message: string }
  | { type: 'run-cancelled' };

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

/** `run-accepted` is Rust-emitted and not in RunEvent; accept it as an extra variant here. */
type Incoming = RunEvent | { type: 'run-accepted' };

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
