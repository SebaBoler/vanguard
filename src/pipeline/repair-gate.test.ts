import { describe, it, expect, vi } from 'vitest';
import { repairUntilGreen } from './repair-gate.js';
import type { RepairGateOptions, GateResult } from './repair-gate.js';
import { STAGE } from './pipeline.js';
import type { PipelineStage, StageOutcome } from './pipeline.js';
import type { RunContext } from '../core/vanguard.js';
import type { RunResult } from '../core/types.js';

type Run = NonNullable<RepairGateOptions<GateResult>['run']>;
const stubRun = (answer: () => RunResult) => vi.fn<Run>((_ctx, _input) => Promise.resolve(answer()));
import type { AgentProvider } from '../agents/provider.js';

const ctx = {} as RunContext;
const agent = { name: 'claude-code', run: vi.fn() } as unknown as AgentProvider;
const pipeline = [{ name: STAGE.IMPLEMENTER, promptTemplate: 'p', maxTurns: 30, stageCostFraction: 0.6, stageCostFloorUsd: 1 }] as unknown as PipelineStage[];
const result = (over: Partial<RunResult> = {}): RunResult => ({ completed: true, exitReason: 'completed', turns: 3, finalText: '', sessionId: 'sess-1', costUsd: 1, ...over } as RunResult);
const outcomesWith = (model?: string): StageOutcome[] => [{ name: STAGE.IMPLEMENTER, result: result(), ...(model !== undefined ? { model } : {}) }];
/** Gate that is red for the first `redTimes` calls, then green. */
const gateRedThenGreen = (redTimes: number) => {
  let calls = 0;
  return async () => { calls += 1; return { pass: calls > redTimes, feedback: `gap ${calls}` }; };
};

describe('repairUntilGreen', () => {
  it('green gate: no repair, no agent call', async () => {
    const run = stubRun(() => result());
    const out = await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(0), agent, outcomes: outcomesWith(), pipeline, maxIterations: 2, run });
    expect(out).toEqual({ passed: true, iterations: 0, last: { pass: true, feedback: 'gap 1' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('red then green: resumes the implementer session on its model with its turn cap and a per-call budget, merges the cost', async () => {
    const run = stubRun(() => result({ sessionId: 'sess-2', costUsd: 0.5, turns: 2 }));
    const outcomes = outcomesWith('claude-sonnet-5-5');
    const out = await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(1), agent, outcomes, pipeline, maxIterations: 2, run, log: () => {} });
    expect(out.passed).toBe(true);
    expect(out.iterations).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]![1];
    expect(input).toEqual(expect.objectContaining({ agent, resumeSessionId: 'sess-1', model: 'claude-sonnet-5-5', maxTurns: 30, maxBudgetUsd: 3 }));
    expect(JSON.stringify(input)).toContain('gap 1');
    expect(JSON.stringify(input)).toContain('<promise>COMPLETE</promise>');
    // Repair cost merged into the implementer outcome, attempts counted.
    expect(outcomes[0]!.result.costUsd).toBe(1.5);
    expect(outcomes[0]!.result.attempts).toBe(2);
  });

  it('escalates from the second repair on unless a per-task label pinned the model', async () => {
    const run = stubRun(() => result());
    const outcomes = outcomesWith('sonnet');
    await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(2), agent, outcomes, pipeline, maxIterations: 3, escalateModel: 'claude-fable-5-1', run, log: () => {} });
    expect(run.mock.calls[0]![1]['model']).toBe('sonnet');
    expect(run.mock.calls[1]![1]['model']).toBe('claude-fable-5-1');
    expect(outcomes[0]!.model).toBe('claude-fable-5-1'); // stats attribute the closing attempt to the model that closed it

    const pinned = stubRun(() => result());
    const pinnedOutcomes = outcomesWith('sonnet');
    await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(2), agent, outcomes: pinnedOutcomes, pipeline, maxIterations: 3, escalateModel: 'claude-fable-5-1', modelPinned: true, run: pinned, log: () => {} });
    expect(pinned.mock.calls[1]![1]['model']).toBe('sonnet');
    expect(pinnedOutcomes[0]!.model).toBe('sonnet');
  });

  it('stops at the iteration cap and reports the remaining gaps', async () => {
    const run = stubRun(() => result());
    const out = await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(99), agent, outcomes: outcomesWith(), pipeline, maxIterations: 2, run, log: () => {} });
    expect(out.passed).toBe(false);
    expect(out.iterations).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(out.last.feedback).toBe('gap 3');
  });

  it('cannot repair without a resumable session: one gate run, no agent call', async () => {
    const run = stubRun(() => result());
    const { sessionId: _none, ...noSession } = result();
    const outcomes: StageOutcome[] = [{ name: STAGE.IMPLEMENTER, result: noSession as RunResult }];
    const out = await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(99), agent, outcomes, pipeline, maxIterations: 2, run });
    expect(out).toEqual({ passed: false, iterations: 0, last: { pass: false, feedback: 'gap 1' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('threads the cancel signal into every repair and follows a renewed session id', async () => {
    const signal = new AbortController().signal;
    const run = stubRun(() => result({ sessionId: 'sess-next' }));
    await repairUntilGreen(ctx, { label: 't', gate: gateRedThenGreen(2), agent, outcomes: outcomesWith(), pipeline, maxIterations: 3, signal, run, log: () => {} });
    expect(run.mock.calls[0]![1]['signal']).toBe(signal);
    expect(run.mock.calls[1]![1]['resumeSessionId']).toBe('sess-next');
  });
});
