import type { Task } from '../tasks/fetcher.js';

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

export const DECISION_MODEL_DEFAULT = 'clef-flash';
/** Ordered difficulty rubric; the score answer is a probability-weighted index into it (0..4). */
export const DIFFICULTY_LEVELS = ['Trivial', 'Routine', 'Moderate', 'Hard', 'Research-grade'] as const;
const REQUEST_TIMEOUT_MS = 10_000;
/** State is truncated so a long thread never blows the model's 64K context or the request budget. */
const MAX_STATE_CHARS = 24_000;

export interface DecisionProbeConfig {
  url: string;
  token?: string;
  model: string;
}

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

/** Workers AI only hosts these two; anything else on that route is a typo that would 400 silently. */
const WORKERS_AI_MODELS = new Set(['clef', 'clef-flash']);

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
  const model = env['VANGUARD_DECISION_MODEL'] ?? DECISION_MODEL_DEFAULT;
  const url = env['VANGUARD_DECISION_URL'];
  if (url !== undefined && url !== '') {
    return { url, model, ...(env['VANGUARD_DECISION_TOKEN'] !== undefined ? { token: env['VANGUARD_DECISION_TOKEN'] } : {}) };
  }
  const account = env['CLOUDFLARE_ACCOUNT_ID'];
  const token = env['CLOUDFLARE_AUTH_TOKEN'];
  if (account === undefined || account === '' || token === undefined || token === '') return undefined;
  if (!WORKERS_AI_MODELS.has(model)) {
    console.warn(`vanguard: difficulty probe disabled — VANGUARD_DECISION_MODEL "${model}" is not a Workers AI decision model (clef, clef-flash)`);
    return undefined;
  }
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/cloudflare/${model}`,
    token,
    model,
  };
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

const QUESTIONS = {
  completes_first_try: {
    type: 'noul',
    instructions:
      'An autonomous coding agent on the named implementer model will implement this task in an isolated sandbox. Will its first attempt pass the project tests and every acceptance criterion in the spec, without any repair pass?',
  },
  difficulty: {
    type: 'score',
    instructions: 'How hard is this task for an autonomous coding agent, considering scope, ambiguity, and how many files/subsystems it touches?',
    criteria: [...DIFFICULTY_LEVELS],
  },
  spec_clear: {
    type: 'noul',
    instructions: 'Is the task specified clearly enough (acceptance criteria, files, expected behaviour) to implement without guessing?',
  },
} as const;

interface SystemOneResponse {
  result?: SystemOneBody;
  // A bare System-One endpoint returns the body directly; Workers AI wraps it in `result`.
  model?: string;
  answers?: SystemOneBody['answers'];
  usage?: SystemOneBody['usage'];
}
interface SystemOneBody {
  model?: string;
  answers?: Record<string, { type?: string; noul?: number; score?: number; confidence?: number }>;
  usage?: { input_tokens?: number };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface ProbeOptions {
  config?: DecisionProbeConfig | undefined;
  /** Run cancel signal; the probe also has its own 10 s timeout. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Ask the decision model about the task. Never throws: any failure (network, non-2xx, malformed body,
 * timeout, cancel) returns undefined — a log-only probe must not be able to fail a run. A configured
 * probe that fails says so on stderr (one line, no URL: the path embeds the account id), because a
 * misconfiguration that looks exactly like "disabled" would never get fixed.
 */
export async function probeTaskDifficulty(
  task: Task,
  implementerModel: string | undefined,
  opts: ProbeOptions = {},
): Promise<DecisionProbeResult | undefined> {
  const config = 'config' in opts ? opts.config : decisionProbeConfig();
  if (config === undefined) return undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const started = Date.now();
  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token !== undefined ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ model: config.model, state: probeState(task, implementerModel), questions: QUESTIONS }),
      signal,
    });
    if (!res.ok) {
      console.warn(`vanguard: difficulty probe failed (HTTP ${res.status}) — check the probe credentials/model`);
      return undefined;
    }
    const parsed = (await res.json()) as SystemOneResponse;
    const body = parsed.result ?? parsed;
    const a = body.answers ?? {};
    const completesFirstTry = num(a['completes_first_try']?.noul);
    const difficulty = num(a['difficulty']?.score);
    const difficultyConfidence = num(a['difficulty']?.confidence);
    const specClear = num(a['spec_clear']?.noul);
    if (completesFirstTry === undefined || difficulty === undefined || specClear === undefined) {
      console.warn('vanguard: difficulty probe returned no usable answers — is the endpoint System-One compatible?');
      return undefined;
    }
    const inputTokens = num(body.usage?.input_tokens);
    return {
      model: body.model ?? config.model,
      completesFirstTry,
      difficulty,
      difficultyConfidence: difficultyConfidence ?? 0,
      specClear,
      latencyMs: Date.now() - started,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
    };
  } catch (err) {
    // A cancelled run is not a misconfiguration; everything else is worth one line.
    if (opts.signal?.aborted !== true) {
      console.warn(`vanguard: difficulty probe failed (${err instanceof Error ? err.name : 'error'})`);
    }
    return undefined;
  }
}
