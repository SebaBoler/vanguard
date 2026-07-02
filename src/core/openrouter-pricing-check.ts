import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENROUTER_PRICING, PRICED_MODELS } from './openrouter-pricing.js';
import { parseJsonlLines } from './stats.js';

/** OpenRouter /models response subset we depend on. Prices are USD-per-TOKEN strings. */
export interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
  };
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/** Injectable fetcher; default impl does the real network call. */
export type ModelsFetcher = () => Promise<OpenRouterModelsResponse>;

export interface StalePrice {
  tableKey: string;
  slug: string;
  field: 'input' | 'output' | 'cacheRead';
  stored: number;
  live: number;
}

export interface UnpricedModel {
  model: string;
  source: 'metrics';
}

export interface MissingLiveModel {
  tableKey: string;
  slug: string;
}

export interface DriftReport {
  stale: StalePrice[];
  unpriced: UnpricedModel[];
  missingLive: MissingLiveModel[];
  checkedRows: number;
  usedModelsScanned: number;
}

// Prices are clean per-MTok decimals, but `perToken * 1_000_000` reintroduces float error
// (e.g. 0.0000002 * 1e6 !== 0.2 exactly). Compare with an absolute epsilon on the reconstructed
// per-MTok value rather than rounding, so a real sub-cent drift on cheap models isn't masked.
const EPSILON = 1e-9;

/** Convert an OpenRouter per-token price string to per-MTok, or undefined if absent/NaN. */
export function toPerMTok(perToken: string | undefined): number | undefined {
  if (perToken === undefined) return undefined;
  const n = Number(perToken);
  if (!Number.isFinite(n)) return undefined;
  return n * 1_000_000;
}

/** Exact match within epsilon on the reconstructed per-MTok value. */
export function pricesEqual(stored: number, live: number): boolean {
  return Math.abs(stored - live) <= EPSILON;
}

const FIELD_TO_PRICING_KEY = {
  input: 'prompt',
  output: 'completion',
  cacheRead: 'input_cache_read',
} as const;

/** Pure. Compares the table against a canned/live payload + a set of used-model strings. */
export function computeDrift(models: OpenRouterModelsResponse, usedModels: ReadonlySet<string>): DriftReport {
  const index = new Map(models.data.map((m) => [m.id, m]));

  const stale: StalePrice[] = [];
  const missingLive: MissingLiveModel[] = [];

  for (const [tableKey, row] of Object.entries(PRICED_MODELS)) {
    const live = index.get(row.openRouterModel);
    if (live === undefined) {
      missingLive.push({ tableKey, slug: row.openRouterModel });
      continue;
    }
    for (const field of ['input', 'output', 'cacheRead'] as const) {
      const livePerMTok = toPerMTok(live.pricing?.[FIELD_TO_PRICING_KEY[field]]);
      if (livePerMTok === undefined) continue;
      const stored = row[field];
      if (!pricesEqual(stored, livePerMTok)) {
        stale.push({ tableKey, slug: row.openRouterModel, field, stored, live: livePerMTok });
      }
    }
  }

  const priced = new Set(Object.keys(OPENROUTER_PRICING));
  const unpriced: UnpricedModel[] = [];
  for (const model of usedModels) {
    if (!priced.has(model)) unpriced.push({ model, source: 'metrics' });
  }

  return {
    stale,
    unpriced,
    missingLive,
    checkedRows: Object.keys(PRICED_MODELS).length,
    usedModelsScanned: usedModels.size,
  };
}

/** Format a DriftReport as a human-readable multi-line report. */
export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = [];

  if (report.stale.length === 0 && report.unpriced.length === 0 && report.missingLive.length === 0) {
    lines.push('No drift detected — all priced rows match live OpenRouter prices, all used models are priced.');
    return lines.join('\n');
  }

  if (report.stale.length > 0) {
    lines.push('Stale prices (stored vs live, per MTok):');
    const sorted = [...report.stale].sort((a, b) => a.tableKey.localeCompare(b.tableKey) || a.field.localeCompare(b.field));
    for (const s of sorted) {
      lines.push(`  ${s.tableKey} [${s.slug}] ${s.field}: stored=${s.stored} live=${s.live}`);
    }
  }

  if (report.unpriced.length > 0) {
    lines.push('Unpriced used models:');
    const sorted = [...report.unpriced].sort((a, b) => a.model.localeCompare(b.model));
    for (const u of sorted) {
      lines.push(`  ${u.model} (source: ${u.source})`);
    }
  }

  if (report.missingLive.length > 0) {
    lines.push('Rows not found in live OpenRouter payload (unverified):');
    const sorted = [...report.missingLive].sort((a, b) => a.tableKey.localeCompare(b.tableKey));
    for (const m of sorted) {
      lines.push(`  ${m.tableKey} [${m.slug}]`);
    }
  }

  return lines.join('\n');
}

/** Default fetcher hitting the public endpoint (no auth header). */
export const fetchOpenRouterModels: ModelsFetcher = async (): Promise<OpenRouterModelsResponse> => {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenRouter models request failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as OpenRouterModelsResponse;
};

/** Pure. Parse run_complete metrics into a deduped set of used model strings. */
export function scanUsedModelsFromMetricsText(text: string): Set<string> {
  const used = new Set<string>();
  for (const parsed of parseJsonlLines(text)) {
    if (parsed.evt === 'run_complete' && typeof parsed.model === 'string' && parsed.model !== '') {
      used.add(parsed.model);
    }
  }
  return used;
}

/** Read .vanguard/runs/metrics.jsonl and return distinct used-model strings; empty if absent. */
export async function scanUsedModels(repoPath: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(join(repoPath, '.vanguard', 'runs', 'metrics.jsonl'), 'utf8');
  } catch {
    return new Set();
  }
  return scanUsedModelsFromMetricsText(text);
}

/** Exit code for --strict mode: 1 iff actual drift (stale or unpriced) was found; missingLive never fails. */
export function strictExitCode(report: DriftReport): number {
  return report.stale.length > 0 || report.unpriced.length > 0 ? 1 : 0;
}

/** Orchestrator used by the script: fetch (injectable) + compute drift. Never auto-writes. */
export async function runPricingCheck(opts: {
  fetcher?: ModelsFetcher;
  usedModels: ReadonlySet<string>;
}): Promise<DriftReport> {
  const fetcher = opts.fetcher ?? fetchOpenRouterModels;
  const models = await fetcher();
  return computeDrift(models, opts.usedModels);
}
