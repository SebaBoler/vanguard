import { readBranchFile } from '../core/metrics-branch.js';
import { parseJsonlLines } from '../core/stats.js';
import type { ApproverPolicy } from './types.js';

export const DECISIONS_FILE = 'decisions.jsonl';

/** `src/<dir>` for a src-rooted path; else the first path segment when the path has more than one; else `(root)`. */
export function moduleOf(path: string): string {
  const parts = path.split('/');
  if (parts[0] === 'src' && parts[1] !== undefined && parts[1] !== '') return `src/${parts[1]}`;
  if (parts.length > 1) return parts[0]!;
  return '(root)';
}

export interface ReadLedgerInput {
  repoPath: string;
  policy: ApproverPolicy;
  now: Date;
  prNumber: number;
  touchedPaths: string[];
  branch?: string;
}

/**
 * Trailing `windowDays` sum of would-approve lines per module this PR touches, read from
 * `decisions.jsonl` on the metrics branch. Only APPROVE records count; a record for the same PR
 * number is skipped (a re-decision must not double count); malformed lines are dropped by
 * parseJsonlLines. Each kept record contributes its `signals.lines` to every module in its own
 * `signals.paths` (not per-path lines — see risk R10 in the tech spec).
 */
export async function readLedger(input: ReadLedgerInput): Promise<Record<string, number>> {
  const text = await readBranchFile(input.repoPath, { ...(input.branch !== undefined ? { branch: input.branch } : {}), file: DECISIONS_FILE });
  const cutoff = input.now.getTime() - input.policy.ledger.windowDays * 24 * 60 * 60 * 1000;
  const relevantModules = new Set(input.touchedPaths.map(moduleOf));
  const totals: Record<string, number> = {};
  for (const record of parseJsonlLines(text)) {
    if (record.verdict !== 'APPROVE') continue;
    if (record.prNumber === input.prNumber) continue;
    const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const signals = record.signals as { lines?: unknown; paths?: unknown } | undefined;
    const lines = typeof signals?.lines === 'number' ? signals.lines : 0;
    const paths = Array.isArray(signals?.paths) ? (signals.paths as unknown[]) : [];
    const modules = new Set(paths.filter((path): path is string => typeof path === 'string').map(moduleOf));
    for (const mod of modules) {
      if (!relevantModules.has(mod)) continue;
      totals[mod] = (totals[mod] ?? 0) + lines;
    }
  }
  return totals;
}
