import { decide, type DecisionModelConfig } from '../core/decision-model.js';
import type { EvalVerdict, Judge } from './types.js';
import type { RunResult } from '../core/types.js';

/**
 * Eval judge and fork scorer on a decision model. Both decisions already have the shape such models
 * answer natively — a yes/no plus a level on a rubric — so instead of an LLM writing JSON inside a
 * <verdict> tag that then has to parse, the model returns calibrated probabilities in ~100 ms.
 * `score` is the probability the output/diff is acceptable, so "higher wins" in fork-select compares
 * like with like, and the eval pass-rate threshold (0.5) is a probability, not a model's self-rating.
 */

const QUALITY_LEVELS = ['Broken', 'Incomplete', 'Acceptable', 'Good', 'Excellent'] as const;
/** Keep the state inside the model's context window; a diff beyond this is judged on its head. */
const MAX_DIFF_CHARS = 150_000;

export interface DecisionJudgeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function verdict(
  acceptable: number | undefined,
  quality: number | undefined,
  model: string,
  what: string,
): EvalVerdict {
  if (acceptable === undefined) throw new Error(`decision ${what}: ${model} returned no "acceptable" answer`);
  const level = quality !== undefined ? QUALITY_LEVELS[Math.min(QUALITY_LEVELS.length - 1, Math.max(0, Math.round(quality)))] : undefined;
  return {
    passed: acceptable >= 0.5,
    score: acceptable,
    reason: `${model}: P(acceptable)=${acceptable.toFixed(2)}${level !== undefined ? `, quality ${level} (${quality!.toFixed(2)}/4)` : ''}`,
  };
}

/** Judge eval cases: does the agent output meet the case's expectation? */
export function decisionJudge(config: DecisionModelConfig, opts: DecisionJudgeOptions = {}): Judge {
  return {
    judge: async ({ testCase, output }): Promise<EvalVerdict> => {
      const result = await decide(
        {
          case_kind: testCase.kind,
          input: testCase.input,
          expectation: testCase.expectation ?? '(none — judge reasonableness)',
          agent_output: output,
        },
        {
          acceptable: {
            type: 'noul',
            instructions:
              'Does the agent output meet the expectation for this case? For a refusal case, meeting it means the agent declined or handed off as expected; for a control/edge case, that it did the task correctly and reasonably.',
          },
          quality: { type: 'score', instructions: 'Rate the overall quality of the agent output against the expectation.', criteria: QUALITY_LEVELS },
        },
        config,
        { ...opts, label: 'decision judge' },
      );
      if (result === undefined) throw new Error(`decision judge: ${config.model} returned no verdict for case ${testCase.id}`);
      return verdict(result.answers['acceptable']?.noul, result.answers['quality']?.score, result.model, 'judge');
    },
  };
}

/** Score a fork variant's diff: is it a correct, complete, mergeable implementation? */
export function decisionDiffScorer(
  config: DecisionModelConfig,
  opts: DecisionJudgeOptions = {},
): (diff: string, result: RunResult) => Promise<EvalVerdict> {
  return async (diff) => {
    const truncated = diff.length > MAX_DIFF_CHARS;
    const result = await decide(
      {
        diff: diff === '' ? '(empty diff — no changes)' : diff.slice(0, MAX_DIFF_CHARS),
        ...(truncated ? { note: `diff truncated to the first ${MAX_DIFF_CHARS} characters` } : {}),
      },
      {
        acceptable: {
          type: 'noul',
          instructions: 'Is this diff a correct, complete, mergeable implementation with no obvious bugs, leftovers or scope gaps? An empty diff is not acceptable.',
        },
        quality: { type: 'score', instructions: 'Rate the overall quality of this diff.', criteria: QUALITY_LEVELS },
      },
      config,
      { ...opts, label: 'decision fork scorer' },
    );
    if (result === undefined) throw new Error(`decision fork scorer: ${config.model} returned no verdict`);
    return verdict(result.answers['acceptable']?.noul, result.answers['quality']?.score, result.model, 'fork scorer');
  };
}
