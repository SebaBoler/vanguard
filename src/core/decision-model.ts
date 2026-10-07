/**
 * Minimal client for "decision models" speaking the System One API (Cloudflare Clef on Workers AI,
 * Typesafe Jev, or any self-hosted endpoint with the same contract): structured state + typed
 * questions in, a calibrated probability per allowed answer out, in ~100 ms, no text generation.
 * Used by the log-only difficulty probe, the eval judge and the fork scorer.
 */

export const DECISION_MODEL_DEFAULT = 'clef-flash';
/** Workers AI hosts exactly these two; any other name on that route is a typo that would 400 silently. */
const WORKERS_AI_MODELS = new Set(['clef', 'clef-flash']);
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DecisionModelConfig {
  url: string;
  token?: string;
  model: string;
}

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

export interface DecisionAnswer {
  type?: string;
  /** noul: probability the answer is yes. */
  noul?: number;
  /** choice: the highest-probability option. */
  choice?: string;
  /** score: probability-weighted level index, 0 = first criterion; can land between levels. */
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  inputTokens?: number;
}

/**
 * Credentials only — the caller decides whether a feature may use them (the probe adds its own
 * explicit switch because it runs unattended on issue text). `model` may be overridden per call site;
 * on the Workers AI route it must be one of the models Cloudflare hosts.
 */
export function decisionModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  model: string = env['VANGUARD_DECISION_MODEL'] ?? DECISION_MODEL_DEFAULT,
): DecisionModelConfig | undefined {
  const url = env['VANGUARD_DECISION_URL'];
  if (url !== undefined && url !== '') {
    return { url, model, ...(env['VANGUARD_DECISION_TOKEN'] !== undefined ? { token: env['VANGUARD_DECISION_TOKEN'] } : {}) };
  }
  const account = env['CLOUDFLARE_ACCOUNT_ID'];
  const token = env['CLOUDFLARE_AUTH_TOKEN'];
  if (account === undefined || account === '' || token === undefined || token === '') return undefined;
  if (!WORKERS_AI_MODELS.has(model)) {
    console.warn(`vanguard: decision model "${model}" is not a Workers AI decision model (clef, clef-flash) — disabled`);
    return undefined;
  }
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/cloudflare/${model}`,
    token,
    model,
  };
}

/** Names that select a decision model instead of an LLM wherever a model flag accepts one. */
export function isDecisionModelName(model: string): boolean {
  return model === 'clef' || model === 'clef-flash' || model === 'jev';
}

interface SystemOneBody {
  model?: string;
  answers?: Record<string, DecisionAnswer>;
  usage?: { input_tokens?: number };
}
interface SystemOneResponse extends SystemOneBody {
  /** Workers AI wraps the body in `result`; a bare System-One endpoint returns it directly. */
  result?: SystemOneBody | null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface DecideOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Names the caller in the one warning line a failed call emits (never the URL: it embeds the account id). */
  label?: string;
}

/**
 * One System One call. Never throws: network, non-2xx, timeout, cancel or a malformed body all return
 * undefined after one stderr line (none on cancel), so each caller decides what "no answer" means —
 * the probe logs nothing, a judge fails the case.
 */
export async function decide(
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  config: DecisionModelConfig,
  opts: DecideOptions = {},
): Promise<DecisionResult | undefined> {
  const label = opts.label ?? 'decision model';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const started = Date.now();
  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token !== undefined ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal,
    });
    if (!res.ok) {
      console.warn(`vanguard: ${label} failed (HTTP ${res.status}) — check the decision-model credentials/model`);
      return undefined;
    }
    const parsed = (await res.json()) as SystemOneResponse;
    const body = parsed.result ?? parsed;
    if (body.answers === undefined || typeof body.answers !== 'object') {
      console.warn(`vanguard: ${label} returned no answers — is the endpoint System-One compatible?`);
      return undefined;
    }
    const inputTokens = num(body.usage?.input_tokens);
    return {
      model: body.model ?? config.model,
      answers: body.answers,
      latencyMs: Date.now() - started,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
    };
  } catch (err) {
    if (opts.signal?.aborted !== true) {
      console.warn(`vanguard: ${label} failed (${err instanceof Error ? err.name : 'error'})`);
    }
    return undefined;
  }
}
