import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeQuotaSnapshot, type QuotaSnapshot } from '../sandbox/llm-proxy-rewrite.mjs';
import type { ReasoningEffort } from '../core/types.js';

export type { QuotaSnapshot };

/** A quota pool. Many models may draw from one bucket. */
export type BucketId = string;

function bucketPath(cacheDir: string, bucket: BucketId): string {
  return join(cacheDir, `${bucket}.json`);
}

/** Read a bucket's last snapshot; undefined when absent or unparseable. */
export function readSnapshot(cacheDir: string, bucket: BucketId): QuotaSnapshot | undefined {
  const path = bucketPath(cacheDir, bucket);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof (parsed as { usedPct?: unknown }).usedPct !== 'number' ||
      typeof (parsed as { resetAt?: unknown }).resetAt !== 'number' ||
      typeof (parsed as { fetchedAt?: unknown }).fetchedAt !== 'number'
    ) {
      return undefined;
    }
    return parsed as QuotaSnapshot;
  } catch {
    return undefined;
  }
}

/** Write a bucket's snapshot (one file per bucket → single writer, no lock). */
export function writeSnapshot(cacheDir: string, bucket: BucketId, snap: QuotaSnapshot): void {
  mkdirSync(cacheDir, { recursive: true });
  writeQuotaSnapshot(bucketPath(cacheDir, bucket), snap);
}

/** A model and the bucket + transport env it uses. */
export interface ModelEntry {
  /** Exact model id passed as --model. */
  key: string;
  /** Quota pool this model draws from. */
  bucket: BucketId;
  /** Default reasoning effort (a stage's own effort overrides this). */
  effort?: ReasoningEffort;
  /** Per-stage env overlay selecting this model's transport/auth. */
  env: Record<string, string>;
  /** Per-stage real credentials for this model, delivered via tmpfs (not argv). Optional. */
  secrets?: Record<string, string>;
}

/** True when a bucket has quota headroom right now (implementations cache/refresh internally). */
export interface BucketCheck {
  available(): Promise<boolean>;
}

export class AllBucketsFlooredError extends Error {
  constructor(preferred: string) {
    super(`All buckets floored for chain starting at '${preferred}'`);
    this.name = 'AllBucketsFlooredError';
  }
}

const warnedConfig = new Set<string>();
function warnOnce(key: string, msg: string) { if (!warnedConfig.has(key)) { warnedConfig.add(key); console.warn(msg); } }

/** First entry in `chain` (from `preferred` onward) whose bucket is available; throws if none. */
export async function resolveModel(
  preferred: string,
  chain: string[],
  models: ModelEntry[],
  checks: Record<BucketId, BucketCheck>,
): Promise<ModelEntry> {
  const start = chain.indexOf(preferred);
  if (start < 0) {
    warnOnce(`resolveModel:preferred-not-in-chain:${preferred}`, `[quota] preferred model '${preferred}' is not in the fallback chain; starting from the first chain entry.`);
  }
  const ordered = start >= 0 ? chain.slice(start) : chain;
  for (const key of ordered) {
    const entry = models.find((m) => m.key === key);
    if (entry === undefined) continue;
    const check = checks[entry.bucket];
    if (check === undefined) {
      warnOnce(`resolveModel:no-check:${entry.bucket}`, `[quota] bucket '${entry.bucket}' has no BucketCheck configured; treating as available.`);
    }
    if (check === undefined || (await check.available())) return entry;
  }
  throw new AllBucketsFlooredError(preferred);
}

export interface PctCheckOptions {
  /** usedPct at/above which the bucket is considered floored. */
  bailPct: number;
  /** Refresh when the cached snapshot is older than this (ms). */
  ttlMs: number;
  /** Optional active refresh (z.ai monitor poll). Omit for header-fed buckets (Claude). */
  refresh?: () => Promise<QuotaSnapshot>;
}


/**
 * Bucket check from a percent-used snapshot in the cache. Refreshes when stale (if a refresh fn is
 * given). On refresh failure, falls back to the last snapshot. With no usable snapshot it returns
 * available (best-effort terminal fallback) and, for a header-fed bucket, warns once that no quota
 * data exists — a sign the bucket is not routed through vanguard's sidecar (e.g. Claude via LiteLLM,
 * which strips the headers).
 */
export function pctBucketCheck(cacheDir: string, bucket: BucketId, opts: PctCheckOptions): BucketCheck {
  let warnedMissing = false;
  return {
    available: async () => {
      let snap = readSnapshot(cacheDir, bucket);
      const stale = snap === undefined || Date.now() - snap.fetchedAt > opts.ttlMs;
      if (stale && opts.refresh !== undefined) {
        try {
          snap = await opts.refresh();
          writeSnapshot(cacheDir, bucket, snap);
        } catch {
          // keep last snapshot; a refresh/usage-endpoint error must never read as "floored"
        }
      }
      if (snap === undefined) {
        if (opts.refresh === undefined && !warnedMissing) {
          warnedMissing = true;
          console.warn(
            `[quota] no snapshots for header-fed bucket '${bucket}'. ` +
              `Usage tracking needs it routed through vanguard's sidecar; LiteLLM strips the rate-limit headers.`,
          );
        }
        return true;
      }
      return snap.usedPct < opts.bailPct;
    },
  };
}

const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

/** Most-depleted window wins (matches z.ai's rolling 5h + weekly token windows). */
export function worstWindow(windows: Array<{ usedPct: number; resetAt: number }>, now = Date.now()): QuotaSnapshot {
  const worst = windows.reduce(
    (a, b) => (b.usedPct > a.usedPct ? b : a),
    { usedPct: 0, resetAt: 0 },
  );
  return { usedPct: worst.usedPct, resetAt: worst.resetAt, fetchedAt: now };
}

/**
 * Read the z.ai monitor endpoint host-side (the z.ai key is the host's, never the sandbox's) and map
 * the TOKENS_LIMIT windows to the worst snapshot. The `refresh` fn for the z.ai pctBucketCheck.
 */
export async function zaiMonitorRefresh(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
  const key = env.ZAI_API_KEY;
  if (key === undefined || key === '') throw new Error('zaiMonitorRefresh needs ZAI_API_KEY in the environment.');
  const res = await fetchImpl(ZAI_QUOTA_URL, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`zaiMonitorRefresh: HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { limits?: Array<{ type: string; percentage?: number; nextResetTime?: number }> };
  };
  const windows = (json.data?.limits ?? [])
    .filter((l) => l.type === 'TOKENS_LIMIT')
    .map((l) => ({ usedPct: l.percentage ?? 0, resetAt: l.nextResetTime ?? 0 }));
  return worstWindow(windows);
}
