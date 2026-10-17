// Port of the run-state machine in apps/desktop/src-tauri/src/sidecar.rs (api_create_run and its
// supporting functions: emit_event, finish_run, resolve_terminal, has_terminal, buffer eviction) —
// minus the child process and its pipe mutex, since the hub calls the sidecar's typed deps IN-PROCESS.
// See that file for the original Rust implementation and its "why" comments.
import { cancelCurrent } from '../sidecar/cancel.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from '../sidecar/sidecar.js';

/**
 * Single-in-flight only, for now: raising this requires replacing src/sidecar/cancel.ts's
 * module-global AbortController with a per-run registry (wave 2). Do not raise without that.
 */
export const MAX_CONCURRENT_RUNS = 1;
/** Completed runs kept in the backlog buffer before eviction. */
const RETAINED_RUNS = 4;
/** Per-run event cap (crash guard) — a real run emits ~dozens; beyond this the oldest are dropped. */
const MAX_EVENTS_PER_RUN = 2000;

interface BufferedEvent {
  runId: string;
  event: unknown;
}

function eventType(entry: BufferedEvent): string | undefined {
  const event = entry.event as { type?: unknown } | null;
  return typeof event?.type === 'string' ? event.type : undefined;
}

export interface RunSession {
  createRun(params: CreateRunParams): Promise<CreateRunResult>;
  activeRun(): { runId: string; repoPath: string } | null;
  backlog(runId: string): unknown[];
  cancel(): void;
}

/**
 * Create one run session bound to a single `SidecarDeps` + event publisher. One instance is shared
 * by every RPC call for the hub's lifetime (or per-repo, in a future multi-slot wave 2) — it owns the
 * single-in-flight gate, the event ring buffers, and the cancel-flag bookkeeping.
 */
export function createRunSession(deps: SidecarDeps, publish: (name: string, payload: unknown) => void): RunSession {
  let active: { runId: string; repoPath: string } | null = null;
  let counter = 0;
  const buffer = new Map<string, BufferedEvent[]>();
  /** Completed-run ids in finish order, for bounded eviction. */
  const order: string[] = [];
  /** A runId for which cancel was requested — its terminal is `run-cancelled`, not `run-error`. */
  let cancelledRunId: string | null = null;

  function bufferPush(runId: string, payload: BufferedEvent): void {
    let events = buffer.get(runId);
    if (events === undefined) {
      events = [];
      buffer.set(runId, events);
    }
    events.push(payload);
    if (events.length > MAX_EVENTS_PER_RUN) {
      // Evict the SECOND-oldest, never index 0: index 0 is always `run-accepted`, the only event
      // allowed to seed a strip re-attach — evicting it would make an over-cap run's re-attach fold
      // nothing while blocking New-run.
      events.splice(1, 1);
    }
  }

  function hasTerminal(runId: string): boolean {
    const events = buffer.get(runId);
    if (events === undefined) return false;
    return events.some((e) => {
      const t = eventType(e);
      return t === 'run-end' || t === 'run-error' || t === 'run-cancelled';
    });
  }

  function emit(runId: string, event: unknown): void {
    const payload: BufferedEvent = { runId, event };
    bufferPush(runId, payload);
    try {
      publish('api:event', payload);
    } catch {
      // A broken publisher must not break the run itself.
    }
  }

  /** Clear `active` (only if it still names THIS run — a late finish must not disarm a successor that
   * already took over) and evict beyond RETAINED_RUNS. Both callers already read-and-cleared
   * `cancelledRunId` for this run before calling, so there is nothing left to clear here. */
  function finishRun(runId: string): void {
    if (active !== null && active.runId === runId) {
      active = null;
    }
    order.push(runId);
    if (order.length > RETAINED_RUNS) {
      const old = order.shift();
      if (old !== undefined) buffer.delete(old);
    }
  }

  return {
    activeRun: () => active,
    /** The buffered `{runId, event}` payloads for a run, for a re-attaching strip — mirrors Rust's
     * `api_run_backlog`, which returns the same full payloads it buffered (not bare events). */
    backlog: (runId) => buffer.get(runId) ?? [],
    cancel: () => {
      // Out-of-band, direct — no signals: in-process execution means there is no child to SIGUSR2.
      if (active !== null) cancelledRunId = active.runId;
      cancelCurrent();
    },
    async createRun(params: CreateRunParams): Promise<CreateRunResult> {
      // repoPath is required BEFORE minting a runId, so `run-accepted`'s payload is always a string
      // and a rejected call never burns an id.
      const repoPath = params.repoPath;
      if (typeof repoPath !== 'string' || repoPath.trim() === '') {
        throw new BadRequestError('repoPath is required and must be a non-blank string');
      }
      if (active !== null) {
        throw new BadRequestError('a run is already in flight (single-in-flight)');
      }
      const runId = `run-${counter}`;
      counter += 1;
      active = { runId, repoPath };
      emit(runId, { type: 'run-accepted', repoPath });

      let result: CreateRunResult | undefined;
      let errMessage: string | undefined;
      try {
        result = await deps.createRun(params, (e) => emit(runId, e));
      } catch (error) {
        errMessage = error instanceof Error ? error.message : String(error);
      }

      // Was this run cancelled? Read + clear the flag BEFORE finishRun (which also clears it) so the
      // terminal below is computed against the pre-cleanup state, mirroring the Rust RunGuard's Drop
      // order (the guard releases `active`/`cancelled` only after the terminal is decided and emitted).
      const wasCancelled = cancelledRunId === runId;
      if (wasCancelled) cancelledRunId = null;

      if (result !== undefined) {
        // The pipeline already streamed `run-end`; no terminal to synthesize.
        finishRun(runId);
        return result;
      }

      const terminal = wasCancelled ? { type: 'run-cancelled' } : { type: 'run-error', message: errMessage ?? 'run failed' };
      // Only synthesize if no terminal was already streamed (e.g. run-end emitted, then a teardown
      // throw) — "exactly one terminal" must hold even on that path.
      if (!hasTerminal(runId)) emit(runId, terminal);
      finishRun(runId);
      throw new Error(errMessage ?? 'run failed');
    },
  };
}
