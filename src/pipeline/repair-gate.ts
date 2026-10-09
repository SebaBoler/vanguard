import { runAgent } from '../core/vanguard.js';
import { mergeAttempts } from '../core/run-metric.js';
import { literalPrompt } from '../context/prompt-engine.js';
import { DEFAULT_RUN_MAX_COST_USD, STAGE } from './pipeline.js';
import type { RunContext } from '../core/vanguard.js';
import type { AgentProvider } from '../agents/provider.js';
import type { PipelineStage, StageOutcome } from './pipeline.js';

/**
 * The repair gate: run a caller-defined gate, and while it is red resume the implementer's own session
 * with the gate's feedback, bounded by an iteration cap, the implementer's turn cap, a per-call USD cap
 * and the run's cancel signal. Both deliveries use it — the first run (conformance + verification +
 * completion) and a revision (verification) — so the caps, the escalation rule and the cost accounting
 * live here and cannot drift between them.
 *
 * Invariants:
 * - Every repair resumes the implementer's session on the implementer's configured model; omitting the
 *   model would silently hand the repair to the provider default.
 * - Reactive escalation: the first repair stays on the (cheap) implementer model; from the second on,
 *   `escalateModel` takes over when set and no per-task label pinned a model. Reacting to an observed red
 *   gate beats guessing difficulty up front.
 * - Each repair's cost, turns and tokens are merged into the implementer outcome (`mergeAttempts`), and an
 *   escalated repair re-labels the outcome's model, so `vanguard stats` attributes the final attempt to the
 *   model that actually closed the gate.
 * - The per-call budget is stageCostFraction × DEFAULT_RUN_MAX_COST_USD (floored at stageCostFloorUsd):
 *   these calls run outside runStages' accounting, where the stage budget is Infinity.
 */

export interface GateResult {
  pass: boolean;
  /** What to tell the implementer when red; ignored when `pass`. */
  feedback: string;
}

export interface RepairGateOptions<G extends GateResult> {
  /** Task label for log lines. */
  label: string;
  /** Run the gate against the current worktree/sandbox; called before every attempt and once more after the last. */
  gate: () => Promise<G>;
  agent: AgentProvider;
  /** The run's stage outcomes; the implementer entry is updated in place with each repair's cost. */
  outcomes: StageOutcome[];
  /** The pipeline the outcomes came from (turn cap and cost fraction of the implementer stage). */
  pipeline: readonly PipelineStage[];
  maxIterations: number;
  /** Fleet-wide escalation model for the 2nd+ repair; ignored when `modelPinned`. */
  escalateModel?: string;
  /** A per-task label pinned the model: the human's own escalation call, never overridden. */
  modelPinned?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Injected for tests; defaults to the real runAgent. */
  run?: typeof runAgent;
}

export interface RepairGateOutcome<G extends GateResult> {
  passed: boolean;
  iterations: number;
  /** The last gate result (green on success, the remaining gaps otherwise). */
  last: G;
}

export async function repairUntilGreen<G extends GateResult>(ctx: RunContext, opts: RepairGateOptions<G>): Promise<RepairGateOutcome<G>> {
  const log = opts.log ?? console.log;
  const run = opts.run ?? runAgent;
  // The loop only runs while the implementer's session is resumable, so its position in `outcomes`
  // is fixed for the duration.
  const implementerIdx = opts.outcomes.findIndex((o) => o.name === STAGE.IMPLEMENTER);
  let resumeSessionId = implementerIdx !== -1 ? opts.outcomes[implementerIdx]?.result.sessionId : undefined;
  // Without an implementer stage in the pipeline there is no turn cap or cost fraction to inherit:
  // each repair then runs on runAgent's defaults (6 turns, no USD cap). Every shipped flow has one.
  const stage = opts.pipeline.find((s) => s.name === STAGE.IMPLEMENTER);
  // A resumed repair inherits the implementer's own turn cap — runAgent's default (6) is useless for
  // finishing work that already exhausted 30 turns.
  const maxTurns = stage?.maxTurns;
  const budgetUsd = stage?.stageCostFraction !== undefined
    ? Math.max(stage.stageCostFraction * DEFAULT_RUN_MAX_COST_USD, stage.stageCostFloorUsd ?? 0)
    : undefined;

  let iterations = 0;
  for (;;) {
    const last = await opts.gate();
    if (last.pass || iterations >= opts.maxIterations || resumeSessionId === undefined) {
      return { passed: last.pass, iterations, last };
    }
    iterations += 1;
    const escalate = iterations >= 2 && opts.escalateModel !== undefined && opts.modelPinned !== true;
    log(`vanguard: gate FAILED for ${opts.label} (attempt ${iterations}/${opts.maxIterations}) — resuming implement session${escalate ? ` on ${opts.escalateModel}` : ''}`);
    const model = escalate ? opts.escalateModel : opts.outcomes[implementerIdx]?.model;
    const repaired = await run(ctx, {
      // Gate output is author-controlled text (test output, spec); see literalPrompt.
      ...literalPrompt(`${last.feedback}\n\nWhen every gap above is addressed, write <promise>COMPLETE</promise>.`),
      agent: opts.agent,
      resumeSessionId,
      ...(model !== undefined ? { model } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
      // Honor cancel here too, else an aborted run keeps burning repair iterations.
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const prior = opts.outcomes[implementerIdx];
    if (prior !== undefined) {
      opts.outcomes[implementerIdx] = {
        ...prior,
        result: mergeAttempts(prior.result, repaired),
        ...(escalate && opts.escalateModel !== undefined ? { model: opts.escalateModel } : {}),
      };
    }
    resumeSessionId = repaired.sessionId ?? resumeSessionId;
  }
}
