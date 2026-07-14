import { describe, expect, it } from 'vitest';
import { initialTypedRun, reduceTypedRun } from './typedRunReducer';

const ev = (runId: string, event: unknown): Parameters<typeof reduceTypedRun>[1] =>
  ({ runId, event }) as Parameters<typeof reduceTypedRun>[1];

describe('reduceTypedRun', () => {
  it('adopts runId/taskId/stages and steps stage phases last-wins', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'run-accepted' }));
    expect(s.runId).toBe('r1');
    s = reduceTypedRun(s, ev('r1', { type: 'run-start', taskId: 't1', flow: 'default', provider: 'claude', stages: ['implementer', 'reviewer'] }));
    expect(s.taskId).toBe('t1');
    expect(s.stages).toEqual(['implementer', 'reviewer']);
    expect(s.stageState).toEqual({});
    s = reduceTypedRun(s, ev('r1', { type: 'stage-start', name: 'implementer', index: 0, of: 2 }));
    expect(s.stageState[0]).toBe('running');
    s = reduceTypedRun(s, ev('r1', { type: 'stage-end', name: 'implementer', index: 0, of: 2, outcome: 'completed' }));
    expect(s.stageState[0]).toBe('done');
  });

  it('cost is last-wins (cumulative), not summed', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'cost', usdSpent: 0.02 }));
    s = reduceTypedRun(s, ev('r1', { type: 'cost', usdSpent: 0.05 }));
    expect(s.usdSpent).toBe(0.05);
  });

  it('is idempotent on replay (backlog + live overlap)', () => {
    const seq = [
      ev('r1', { type: 'run-start', taskId: 't1', flow: 'f', provider: 'p', stages: ['a'] }),
      ev('r1', { type: 'stage-start', name: 'a', index: 0, of: 1 }),
      ev('r1', { type: 'cost', usdSpent: 0.03 }),
    ];
    let s = initialTypedRun();
    for (const e of seq) s = reduceTypedRun(s, e);
    let s2 = initialTypedRun();
    for (const e of [...seq, ...seq]) s2 = reduceTypedRun(s2, e);
    expect(s2).toEqual(s);
  });

  it('drops payloads from a different runId', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'run-start', taskId: 't1', flow: 'f', provider: 'p', stages: ['a'] }));
    s = reduceTypedRun(s, ev('r2', { type: 'cost', usdSpent: 99 }));
    expect(s.usdSpent).toBe(0);
  });

  it('maps every terminal', () => {
    const t = (event: unknown): TypedRunTerminal =>
      reduceTypedRun(reduceTypedRun(initialTypedRun(), ev('r1', { type: 'run-accepted' })), ev('r1', event)).terminal;
    expect(t({ type: 'run-end', prUrl: 'x' })).toEqual({ kind: 'success', prUrl: 'x' });
    expect(t({ type: 'run-end', secretBlocked: true })).toEqual({ kind: 'secret-blocked' });
    expect(t({ type: 'run-end' })).toEqual({ kind: 'no-changes' });
    expect(t({ type: 'run-error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(t({ type: 'run-cancelled' })).toEqual({ kind: 'cancelled' });
  });
});

type TypedRunTerminal = ReturnType<typeof reduceTypedRun>['terminal'];

// S7: run-accepted stays a desktop extension of the wire RunEvent — this pins the TYPE accepts it
// (the runtime folds above already exercise it).
import type { AppRunEvent } from './typedRunReducer';
const _accepted: AppRunEvent = { type: 'run-accepted' };
void _accepted;
