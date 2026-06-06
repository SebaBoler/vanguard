import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult } from './types.js';

export interface PersistOptions {
  /** ISO timestamp; defaults to now. Injected for deterministic tests. */
  timestamp?: string;
  /** Stage name, when persisting a single stage of a multi-stage run. */
  label?: string;
  /** The PR opened for this run, if any. */
  prUrl?: string;
}

/**
 * Persist a run's metadata to `.vanguard/runs/<taskId>/<ts>[-label].json` and append one compact
 * metric line to `.vanguard/runs/metrics.jsonl`, so an AFK fleet leaves a cost/usage/exit trace. The
 * (potentially large) diff is omitted — the PR carries it. Returns the written JSON path.
 */
export async function persistRunRecord(localRepoPath: string, result: RunResult, opts: PersistOptions = {}): Promise<string> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const runsDir = join(localRepoPath, '.vanguard', 'runs');
  const taskDir = join(runsDir, result.taskId);
  await mkdir(taskDir, { recursive: true });

  const { diff, transcript, ...meta } = result;
  void diff; // omitted from the record on purpose (the PR carries it)
  const record = {
    ...meta,
    timestamp,
    ...(opts.label !== undefined ? { stage: opts.label } : {}),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
  };
  const suffix = opts.label !== undefined ? `-${opts.label}` : '';
  const base = join(taskDir, `${timestamp.replace(/[^0-9A-Za-z]/g, '-')}${suffix}`);
  const file = `${base}.json`;
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  if (transcript !== undefined && transcript !== '') {
    await writeFile(`${base}.transcript.log`, transcript);
  }

  const metric = {
    evt: 'run_complete',
    ts: timestamp,
    taskId: result.taskId,
    ...(opts.label !== undefined ? { stage: opts.label } : {}),
    exitReason: result.exitReason,
    completed: result.completed,
    turns: result.turns,
    costUsd: result.costUsd ?? 0,
    cacheEfficiency: result.cacheEfficiency ?? 0,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
  };
  await appendFile(join(runsDir, 'metrics.jsonl'), `${JSON.stringify(metric)}\n`);
  return file;
}

/** Persist one record per pipeline stage under a shared timestamp (the per-task AFK trace). */
export async function persistStageOutcomes(
  localRepoPath: string,
  outcomes: ReadonlyArray<{ name: string; result: RunResult }>,
  prUrl?: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  for (const outcome of outcomes) {
    await persistRunRecord(localRepoPath, outcome.result, {
      timestamp,
      label: outcome.name,
      ...(prUrl !== undefined ? { prUrl } : {}),
    });
  }
}
