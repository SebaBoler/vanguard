import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from './provider.js';
import {
  resolveModel, pctBucketCheck, readSnapshot, AllBucketsFlooredError,
  type BucketId, type BucketCheck, type ModelEntry, type QuotaSnapshot,
} from './quota.js';
import { ZaiProvider } from './zai.js';

export interface QuotaRoutingOptions {
  delegate: AgentProvider;
  models: ModelEntry[];
  checks: Record<BucketId, BucketCheck>;
  chain: string[];
  cacheDir: string;
  /** Optional sink for a live-burn line logged once at run() entry; omit to disable. */
  debug?: (line: string) => void;
}

/**
 * AgentProvider wrapper that picks a stage's model from a bucket-availability matrix at run() time (the
 * per-stage boundary), overlays that model's transport env + effort, then delegates. Sticky within the
 * wrapper's lifetime: a bucket that floors once stays floored (no flip-back), so "z.ai did the early
 * stages, Claude finishes" — keeping work moving when a window empties rather than stalling.
 */
export class QuotaRoutingProvider implements AgentProvider {
  readonly name = 'quota-routing';
  private readonly floored = new Set<BucketId>();

  constructor(private readonly opts: QuotaRoutingOptions) {}

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const checks = this.stickyChecks();
    const preferred = input.model ?? this.opts.chain[0];
    if (preferred === undefined) throw new AllBucketsFlooredError('(empty chain)');
    const entry = await resolveModel(preferred, this.opts.chain, this.opts.models, checks);
    const next: AgentRunInput = {
      ...input,
      model: entry.key,
      env: { ...(input.env ?? {}), ...entry.env },
      ...(input.effort === undefined && entry.effort !== undefined ? { effort: entry.effort } : {}),
      ...(entry.secrets !== undefined ? { secrets: { ...(input.secrets ?? {}), ...entry.secrets } } : {}),
    };

    const it = this.opts.delegate.run(next);
    if (this.opts.debug !== undefined) this.opts.debug(this.burnLine());
    let r = await it.next();
    while (r.done !== true) {
      yield r.value;
      r = await it.next();
    }
    return r.value;
  }

  /** Wrap each check so a bucket that floors once is treated floored for the rest of this run. */
  private stickyChecks(): Record<BucketId, BucketCheck> {
    const out: Record<BucketId, BucketCheck> = {};
    for (const [bucket, check] of Object.entries(this.opts.checks)) {
      out[bucket] = {
        available: async () => {
          if (this.floored.has(bucket)) return false;
          const ok = await check.available();
          if (!ok) this.floored.add(bucket);
          return ok;
        },
      };
    }
    return out;
  }

  /** One-line live-burn summary across buckets, read from the cache. */
  private burnLine(): string {
    const parts = Object.keys(this.opts.checks).map((bucket) => {
      const snap = readSnapshot(this.opts.cacheDir, bucket);
      if (snap === undefined) return `${bucket} ?`;
      const resetMin = snap.resetAt > 0 ? Math.round((snap.resetAt - Date.now()) / 60_000) : 0;
      return resetMin > 0 ? `${bucket} ${snap.usedPct}% (resets ${resetMin}m)` : `${bucket} ${snap.usedPct}%`;
    });
    return `[quota] ${parts.join(' · ')}`;
  }
}

export interface QuotaBucketConfig {
  bailPct: number;
  ttlMs: number;
  /** z.ai: zaiMonitorRefresh. Claude/header-fed: omit. */
  refresh?: () => Promise<QuotaSnapshot>;
}

export interface QuotaRoutedOptions {
  buckets: Record<BucketId, QuotaBucketConfig>;
  models: ModelEntry[];
  chain: string[];
  cacheDir: string;
  /** Defaults to a ZaiProvider (runClaudeCli with GLM args); the wrapper overrides model + env per stage. */
  delegate?: AgentProvider;
  debug?: (line: string) => void;
}

/** Build a QuotaRoutingProvider from bucket thresholds — the one-call consumer entry point. */
export function quotaRoutedAgent(opts: QuotaRoutedOptions): QuotaRoutingProvider {
  const checks: Record<BucketId, BucketCheck> = {};
  for (const [bucket, cfg] of Object.entries(opts.buckets)) {
    checks[bucket] = pctBucketCheck(opts.cacheDir, bucket, {
      bailPct: cfg.bailPct,
      ttlMs: cfg.ttlMs,
      ...(cfg.refresh !== undefined ? { refresh: cfg.refresh } : {}),
    });
  }
  return new QuotaRoutingProvider({
    delegate: opts.delegate ?? new ZaiProvider(),
    models: opts.models,
    checks,
    chain: opts.chain,
    cacheDir: opts.cacheDir,
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
  });
}
