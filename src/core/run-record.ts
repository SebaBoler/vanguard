import { mkdir, writeFile, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { RunResult } from './types.js';
import { stageMetric } from './run-metric.js';
import type { VerificationResult } from '../pipeline/verify.js';

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
 * (potentially large) diff is written to a sibling `.diff` file and omitted from the JSON record.
 * Returns the written JSON path.
 */
export async function persistRunRecord(localRepoPath: string, result: RunResult, opts: PersistOptions = {}): Promise<string> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const runsDir = join(localRepoPath, '.vanguard', 'runs');
  const taskDir = join(runsDir, result.taskId);
  await mkdir(taskDir, { recursive: true });

  const { diff, transcript, ...meta } = result;
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
  if (transcript) await writeFile(`${base}.transcript.log`, transcript);
  if (diff) await writeFile(`${base}.diff`, diff);
  const bundlePath = `${base}.bundle`;
  try {
    await execa('git', ['-C', result.worktreePath, 'bundle', 'create', bundlePath, 'HEAD']);
  } catch {
    // best-effort: remove any partial file git may have opened before it failed
    await unlink(bundlePath).catch(() => undefined);
  }

  const metric = {
    evt: 'run_complete',
    ts: timestamp,
    ...stageMetric(result, opts.label),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
  };
  await appendFile(join(runsDir, 'metrics.jsonl'), `${JSON.stringify(metric)}\n`);
  return file;
}

export interface PersistVerificationOptions {
  /** ISO timestamp; defaults to now. Injected for deterministic tests. */
  timestamp?: string;
}

/**
 * Persist a verification proof to `.vanguard/runs/<taskId>/<ts>.proof.json` and append one compact
 * metric line `{ evt: 'verify', ts, taskId, passed, exitCode, sha256 }` to `metrics.jsonl`.
 */
export async function persistVerification(
  localRepoPath: string,
  taskId: string,
  result: VerificationResult,
  opts: PersistVerificationOptions = {},
): Promise<string> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const runsDir = join(localRepoPath, '.vanguard', 'runs');
  const taskDir = join(runsDir, taskId);
  await mkdir(taskDir, { recursive: true });

  const base = join(taskDir, `${timestamp.replace(/[^0-9A-Za-z]/g, '-')}`);
  const file = `${base}.proof.json`;
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);

  const metric = { evt: 'verify', ts: timestamp, taskId, passed: result.passed, exitCode: result.exitCode, sha256: result.sha256 };
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
