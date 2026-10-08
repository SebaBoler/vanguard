import type { Task } from '../tasks/fetcher.js';
import { decide, decisionModelConfig, num, type DecisionModelConfig, type DecisionQuestion } from './decision-model.js';

/**
 * Log-only "decision model" probe (System One API: Cloudflare Clef / Typesafe Jev). Before the
 * pipeline starts, one typed query asks a sub-second, probability-returning model how hard the task
 * looks. The answer changes NOTHING about the run — it is persisted next to the run metrics so that,
 * after enough runs, `vanguard stats` can show whether the probe predicts gate repairs/escalation.
 * If it does, it becomes the automatic `vanguard:model=` label; if it does not, it is one env var
 * to unset.
 *
 * Opt-in by an EXPLICIT switch: VANGUARD_DECISION_PROBE=1 (or `all`, see below) plus credentials —
 * CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AUTH_TOKEN (Workers AI) or VANGUARD_DECISION_URL (any
 * System-One-compatible endpoint). The credentials alone never enable it: those are Cloudflare's
 * generic variable names, and a pair exported for unrelated tooling must not silently start shipping
 * issue text off the host. Note what leaves: the task title, labels, description and comments (incl. a
 * posted or --spec-file tech spec) go from the HOST process to the endpoint — outside the sandbox,
 * outside --egress and outside --llm-proxy. White-label runs (client repos) are skipped unless the
 * switch is `all`.
 */

export { DECISION_MODEL_DEFAULT } from './decision-model.js';
/** Ordered difficulty rubric; the score answer is a probability-weighted index into it (0..4). */
export const DIFFICULTY_LEVELS = ['Trivial', 'Routine', 'Moderate', 'Hard', 'Research-grade'] as const;
/** State is truncated so a long thread never blows the model's 64K context or the request budget. */
const MAX_STATE_CHARS = 24_000;

export type DecisionProbeConfig = DecisionModelConfig;

export interface DecisionProbeResult {
  model: string;
  /** Probability the implementer finishes with a green gate on the first attempt (no repair). */
  completesFirstTry: number;
  /** Probability-weighted difficulty level, 0 = DIFFICULTY_LEVELS[0]. */
  difficulty: number;
  difficultyConfidence: number;
  /** Probability the task is specified clearly enough to implement without guessing. */
  specClear: number;
  latencyMs: number;
  inputTokens?: number;
}

/**
 * Resolve the probe endpoint from the host environment; undefined = probe disabled. `whiteLabel`
 * runs need VANGUARD_DECISION_PROBE=all — client issue text must not leave the host by default.
 */
export function decisionProbeConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { whiteLabel?: boolean } = {},
): DecisionProbeConfig | undefined {
  const enabled = env['VANGUARD_DECISION_PROBE'];
  if (enabled !== '1' && enabled !== 'all') return undefined;
  if (opts.whiteLabel === true && enabled !== 'all') return undefined;
  return decisionModelConfig(env);
}

/** The state handed to the model: title, body, labels, and the spec thread, truncated. */
export function probeState(task: Task, implementerModel: string | undefined): Record<string, unknown> {
  const spec = task.comments.map((c) => c.body).join('\n\n');
  return {
    implementer_model: implementerModel ?? 'provider default',
    title: task.title,
    labels: task.labels,
    description: task.description.slice(0, MAX_STATE_CHARS),
    spec_and_comments: spec.slice(0, MAX_STATE_CHARS),
  };
}

const QUESTIONS: Record<string, DecisionQuestion> = {
  completes_first_try: {
    type: 'noul',
    instructions:
      'An autonomous coding agent on the named implementer model will implement this task in an isolated sandbox. Will its first attempt pass the project tests and every acceptance criterion in the spec, without any repair pass?',
  },
  difficulty: {
    type: 'score',
    instructions: 'How hard is this task for an autonomous coding agent, considering scope, ambiguity, and how many files/subsystems it touches?',
    criteria: DIFFICULTY_LEVELS,
  },
  spec_clear: {
    type: 'noul',
    instructions: 'Is the task specified clearly enough (acceptance criteria, files, expected behaviour) to implement without guessing?',
  },
};

export interface ProbeOptions {
  config?: DecisionProbeConfig | undefined;
  /** Run cancel signal; the probe also has its own 10 s timeout. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Ask the decision model about the task. Never throws: any failure returns undefined — a log-only
 * probe must not be able to fail a run. A configured probe that fails says so on stderr (one line).
 */
export async function probeTaskDifficulty(
  task: Task,
  implementerModel: string | undefined,
  opts: ProbeOptions = {},
): Promise<DecisionProbeResult | undefined> {
  const config = 'config' in opts ? opts.config : decisionProbeConfig();
  if (config === undefined) return undefined;
  const result = await decide(probeState(task, implementerModel), QUESTIONS, config, {
    label: 'difficulty probe',
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (result === undefined) return undefined;
  const a = result.answers;
  const completesFirstTry = num(a['completes_first_try']?.noul);
  const difficulty = num(a['difficulty']?.score);
  const specClear = num(a['spec_clear']?.noul);
  if (completesFirstTry === undefined || difficulty === undefined || specClear === undefined) {
    console.warn('vanguard: difficulty probe returned no usable answers — is the endpoint System-One compatible?');
    return undefined;
  }
  return {
    model: result.model,
    completesFirstTry,
    difficulty,
    difficultyConfidence: num(a['difficulty']?.confidence) ?? 0,
    specClear,
    latencyMs: result.latencyMs,
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
  };
}
