import { mkdir, writeFile, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { RunResult } from './types.js';
import { stageMetric } from './run-metric.js';
import { exportRunTrace } from './otlp-sink.js';
import { redactTokens } from './secret-scan.js';
import type { VerificationResult } from '../pipeline/verify.js';
import type { VisualProofResult } from '../pipeline/visual-proof.js';
import type { DecisionProbeResult } from './decision-probe.js';

export interface PersistOptions {
  /** ISO timestamp; defaults to now. Injected for deterministic tests. */
  timestamp?: string;
  /** Stage name, when persisting a single stage of a multi-stage run. */
  label?: string;
  /** The PR opened for this run, if any. */
  prUrl?: string;
  /** Model the stage was configured with (StageOutcome.model); recorded next to the served `model`. */
  requestedModel?: string;
  /**
   * Leave the `.diff` and `.bundle` off disk. Set for secret-blocked runs: their diff holds the very
   * secret the scan caught, and the run record may be uploaded as a CI artifact (`upload-run-records`).
   */
  omitDiff?: boolean;
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
  // The transcript is raw agent output: tool results can echo env or config, so mask known token
  // shapes before it lands on disk (the record may leave the job as a CI artifact).
  if (transcript) await writeFile(`${base}.transcript.log`, redactTokens(transcript));
  if (!opts.omitDiff) {
    if (diff) await writeFile(`${base}.diff`, diff);
    const bundlePath = `${base}.bundle`;
    try {
      await execa('git', ['-C', result.worktreePath, 'bundle', 'create', bundlePath, 'HEAD']);
    } catch {
      // best-effort: remove any partial file git may have opened before it failed
      await unlink(bundlePath).catch(() => undefined);
    }
  }

  const metric = {
    evt: 'run_complete',
    ts: timestamp,
    ...stageMetric(result, opts.label, opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : undefined),
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

/**
 * Append one `{ evt: 'decision_probe', ts, taskId, ... }` line to metrics.jsonl — the log-only
 * difficulty probe, joined to the stage outcomes by taskId in `vanguard stats`.
 */
export async function persistDecisionProbe(
  localRepoPath: string,
  taskId: string,
  probe: DecisionProbeResult,
  opts: { timestamp?: string } = {},
): Promise<void> {
  const runsDir = join(localRepoPath, '.vanguard', 'runs');
  await mkdir(runsDir, { recursive: true });
  const metric = { evt: 'decision_probe', ts: opts.timestamp ?? new Date().toISOString(), taskId, ...probe };
  await appendFile(join(runsDir, 'metrics.jsonl'), `${JSON.stringify(metric)}\n`);
}

export interface PersistVisualProofOptions {
  /** ISO timestamp; defaults to now. Injected for deterministic tests. */
  timestamp?: string;
}

/**
 * Persist a visual proof to `.vanguard/runs/<taskId>/<ts>.visual-proof.json` (the full
 * `VisualProofResult`, including its artifact manifest) and append one compact metric line
 * `{ evt: 'visual_proof', ts, taskId, passed, exitCode, sha256, artifacts }` to `metrics.jsonl`.
 */
export async function persistVisualProof(
  localRepoPath: string,
  taskId: string,
  result: VisualProofResult,
  opts: PersistVisualProofOptions = {},
): Promise<string> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const runsDir = join(localRepoPath, '.vanguard', 'runs');
  const taskDir = join(runsDir, taskId);
  await mkdir(taskDir, { recursive: true });

  const base = join(taskDir, `${timestamp.replace(/[^0-9A-Za-z]/g, '-')}`);
  const file = `${base}.visual-proof.json`;
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);

  const metric = {
    evt: 'visual_proof',
    ts: timestamp,
    taskId,
    passed: result.passed,
    exitCode: result.exitCode,
    sha256: result.sha256,
    artifacts: result.artifacts.length,
  };
  await appendFile(join(runsDir, 'metrics.jsonl'), `${JSON.stringify(metric)}\n`);
  return file;
}

export interface PersistStageOptions {
  /** The PR opened for this run, if any. */
  prUrl?: string;
  /** Flow and provider names of the run, recorded on the exported trace (see otlp-sink). */
  flow?: string;
  provider?: string;
  /** Secret-blocked run: write no `.diff` / `.bundle` for any stage (see PersistOptions.omitDiff). */
  omitDiff?: boolean;
}

/**
 * Persist one record per pipeline stage under a shared timestamp (the per-task AFK trace), then mirror
 * the run as one OTLP trace when an exporter is configured (opt-in, best-effort — see otlp-sink).
 */
export async function persistStageOutcomes(
  localRepoPath: string,
  outcomes: ReadonlyArray<{ name: string; result: RunResult; model?: string }>,
  opts: PersistStageOptions = {},
): Promise<void> {
  const timestamp = new Date().toISOString();
  const { omitDiff, ...trace } = opts;
  for (const outcome of outcomes) {
    await persistRunRecord(localRepoPath, outcome.result, {
      timestamp,
      label: outcome.name,
      ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
      ...(outcome.model !== undefined ? { requestedModel: outcome.model } : {}),
      ...(omitDiff ? { omitDiff } : {}),
    });
  }
  const first = outcomes[0];
  if (first === undefined) return;
  await exportRunTrace({
    taskId: first.result.taskId,
    timestamp,
    stages: outcomes.map((o) => stageMetric(o.result, o.name, o.model !== undefined ? { requestedModel: o.model } : undefined)),
    ...trace,
  });
}
