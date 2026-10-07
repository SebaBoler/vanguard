import { decide, num, probability, type DecisionModelConfig } from '../core/decision-model.js';
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
/**
 * Keep the state inside the model's 64K-token window (the endpoint truncates silently past it). A
 * bigger diff is sent as its head and tail halves with the file list, exit reason and a note placed
 * BEFORE the diff so they survive any server-side cut.
 */
const MAX_DIFF_CHARS = 120_000;
/** A 40k-token prefill on a 9B model is not a 10 s call; one retry covers a transient 5xx/timeout. */
const SCORER_TIMEOUT_MS = 45_000;
const JUDGE_TIMEOUT_MS = 20_000;
const RETRIES = 1;

/** `+++ b/path` lines, so the judge knows the diff's shape even when its middle was cut. */
function touchedFiles(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!).slice(0, 200);
}

function clipDiff(diff: string): { diff: string; note?: string } {
  if (diff === '') return { diff: '(empty diff — no changes)' };
  if (diff.length <= MAX_DIFF_CHARS) return { diff };
  const half = Math.floor(MAX_DIFF_CHARS / 2);
  return {
    diff: `${diff.slice(0, half)}\n\n[... ${diff.length - MAX_DIFF_CHARS} characters omitted ...]\n\n${diff.slice(-half)}`,
    note: `diff is ${diff.length} characters; only its first and last ${half} are included`,
  };
}

export interface DecisionJudgeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Judge fields are clipped so the field under judgement is never the one a server-side cut removes. */
const MAX_FIELD_CHARS = 20_000;
const clip = (text: string): string => (text.length <= MAX_FIELD_CHARS ? text : `${text.slice(0, MAX_FIELD_CHARS)}\n[... ${text.length - MAX_FIELD_CHARS} characters omitted ...]`);

function verdict(rawAcceptable: unknown, rawQuality: unknown, model: string, what: string): EvalVerdict {
  // Both paths this replaces validated their numbers (verdictSchema's 0..1, the probe's num()); an
  // endpoint answering on a 0–100 scale or with a string must fail loudly, not pass every case.
  const acceptable = probability(rawAcceptable);
  if (acceptable === undefined) throw new Error(`decision ${what}: ${model} returned no usable "acceptable" probability (got ${JSON.stringify(rawAcceptable)})`);
  const quality = num(rawQuality);
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
      // Key order = truncation priority (the endpoint cuts the serialised state from the end).
      const result = await decide(
        {
          case_kind: testCase.kind,
          expectation: clip(testCase.expectation ?? '(none — judge reasonableness)'),
          agent_output: clip(output),
          input: clip(testCase.input),
        },
        {
          acceptable: {
            type: 'noul',
            instructions:
              'Does the agent output meet the expectation for this case? Judge strictly against the expectation text: when it says the agent should ask, clarify, refuse or hand off, an output that charges ahead and does the work does NOT meet it.',
          },
          quality: { type: 'score', instructions: 'Rate the overall quality of the agent output against the expectation.', criteria: QUALITY_LEVELS },
        },
        config,
        { ...opts, label: 'decision judge', timeoutMs: JUDGE_TIMEOUT_MS, retries: RETRIES },
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
  return async (diff, run) => {
    const clipped = clipDiff(diff);
    // Key order matters: the endpoint truncates the serialised state from the end, so the summary
    // fields and the note come first and the diff last.
    const result = await decide(
      {
        implementer_completed: run.completed,
        implementer_exit_reason: run.exitReason,
        files: touchedFiles(diff),
        ...(clipped.note !== undefined ? { note: clipped.note } : {}),
        diff: clipped.diff,
      },
      {
        acceptable: {
          type: 'noul',
          instructions:
            'Is this diff a correct, complete, mergeable implementation with no obvious bugs, leftovers or scope gaps? An empty diff, or one whose implementer did not complete, is not acceptable.',
        },
        quality: { type: 'score', instructions: 'Rate the overall quality of this diff.', criteria: QUALITY_LEVELS },
      },
      config,
      { ...opts, label: 'decision fork scorer', timeoutMs: SCORER_TIMEOUT_MS, retries: RETRIES },
    );
    if (result === undefined) throw new Error(`decision fork scorer: ${config.model} returned no verdict`);
    return verdict(result.answers['acceptable']?.noul, result.answers['quality']?.score, result.model, 'fork scorer');
  };
}
