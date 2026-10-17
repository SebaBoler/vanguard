// Port of apps/desktop/src-tauri/src/runs.rs — see that file for the original Rust implementation.
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface RunRecord {
  taskId: string;
  completed: boolean;
  exitReason: string;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
  cacheEfficiency?: number;
  durationMs?: number;
  model?: string;
  timestamp: string;
  stage?: string;
  prUrl?: string;
}

export interface Proof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
}

export interface RunSummary {
  taskId: string;
  timestamp: string;
  stages: string[];
  totalCostUsd: number;
  anyFailed: boolean;
  prUrl?: string;
}

export interface StageDetail {
  record: RunRecord;
  diff?: string;
  transcript?: string;
}

export interface RunDetail {
  taskId: string;
  timestamp: string;
  stages: StageDetail[];
  proof?: Proof;
}

/** `<runsRoot>` is the directory directly containing per-task subdirectories. */
export function defaultRunsRoot(repoPath: string): string {
  return join(repoPath, '.vanguard', 'runs');
}

/** Per-task subdirectories under an imported CI run's remote-runs tree. */
export function remoteRunsRoot(repoPath: string, remoteRunId: number): string {
  return join(repoPath, '.vanguard', 'remote-runs', String(remoteRunId));
}

/** Mirror of Vanguard's `timestamp.replace(/[^0-9A-Za-z]/g, '-')` (same regex as src/core/run-record.ts). */
export function sanitizeTimestamp(ts: string): string {
  return ts.replace(/[^0-9A-Za-z]/g, '-');
}

/** Guard against path traversal: a task id must name a single direct child of the runs root. */
function isSafeTaskId(taskId: string): boolean {
  return (
    taskId !== '' && !taskId.includes('/') && !taskId.includes('\\') && !taskId.includes('..') && !isAbsolute(taskId)
  );
}

export function isRunRecordFile(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.proof.json') && !name.endsWith('.visual-proof.json');
}

/**
 * Read a file's text but refuse a symlinked leaf: a repo under inspection could plant a
 * `.diff`/`.transcript.log` pointing at an arbitrary file and have its contents shown in the UI.
 * Guards the leaf symlink only (mirrors the Rust implementation's caveat).
 */
export async function readTextNoSymlink(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error('refusing to read a symlinked file');
  }
  return readFile(path, 'utf8');
}

/** 32-bit FNV-1a over a string; used only to fold file name+mtime into a stable fingerprint. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Cheap, order-independent change-detector for a runs tree: folds each record file's name + mtime
 * together without reading contents. Missing/empty tree -> 0. Does not need to match Rust's
 * DefaultHasher bit-for-bit (this is an independent TS reader).
 */
export async function runsFingerprint(runsRoot: string): Promise<number> {
  let taskDirs;
  try {
    taskDirs = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let fp = 0;
  for (const task of taskDirs) {
    if (!task.isDirectory()) continue;
    const taskPath = join(runsRoot, task.name);
    let files;
    try {
      files = await readdir(taskPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!isRunRecordFile(file.name)) continue;
      let mtimeMs = 0;
      try {
        const info = await stat(join(taskPath, file.name));
        mtimeMs = info.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      fp = (fp + fnv1a(`${file.name}:${mtimeMs}`)) >>> 0;
    }
  }
  return fp;
}

/** Best-effort parse of a run record file; returns undefined on any read or JSON error. */
async function tryReadRecord(path: string): Promise<RunRecord | undefined> {
  try {
    const contents = await readFile(path, 'utf8');
    return JSON.parse(contents) as RunRecord;
  } catch {
    return undefined;
  }
}

/**
 * List and group run summaries under runsRoot. Missing runsRoot -> []. Each task subdirectory's
 * record files are read, parsed, and grouped by `record.timestamp` (unparseable files are skipped).
 */
export async function listRunSummaries(runsRoot: string): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];

  let taskDirs;
  try {
    taskDirs = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summaries;
    throw error;
  }

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue;
    const taskPath = join(runsRoot, taskEntry.name);
    const groups = new Map<string, RunRecord[]>();
    const files = await readdir(taskPath, { withFileTypes: true });
    for (const file of files) {
      if (!isRunRecordFile(file.name)) continue;
      const record = await tryReadRecord(join(taskPath, file.name));
      if (record === undefined) continue;
      const group = groups.get(record.timestamp);
      if (group === undefined) {
        groups.set(record.timestamp, [record]);
      } else {
        group.push(record);
      }
    }
    for (const [timestamp, records] of groups) {
      const first = records[0];
      if (first === undefined) continue;
      const stages = records.map((r) => r.stage ?? 'run').sort();
      const totalCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const anyFailed = records.some((r) => !r.completed);
      const prUrl = records.find((r) => r.prUrl !== undefined)?.prUrl;
      summaries.push({
        taskId: first.taskId,
        timestamp,
        stages,
        totalCostUsd,
        anyFailed,
        ...(prUrl !== undefined ? { prUrl } : {}),
      });
    }
  }

  summaries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return summaries;
}

/**
 * Read the full detail (stages + proof) for one task's run at one timestamp. taskId is validated
 * against path traversal before any filesystem access. A missing task directory propagates as a
 * plain Error (mirrors Rust's `fs::read_dir(&task_dir)?`).
 */
export async function readRunDetail(runsRoot: string, taskId: string, timestamp: string): Promise<RunDetail> {
  if (!isSafeTaskId(taskId)) {
    throw new BadRequestError('invalid task id');
  }
  const taskDir = join(runsRoot, taskId);
  const stages: StageDetail[] = [];

  const files = await readdir(taskDir, { withFileTypes: true });
  for (const file of files) {
    if (!isRunRecordFile(file.name)) continue;
    const path = join(taskDir, file.name);
    const record = await tryReadRecord(path);
    if (record === undefined) continue;
    if (record.timestamp !== timestamp) continue;
    const base = path.endsWith('.json') ? path.slice(0, -'.json'.length) : path;
    const diff = await readTextNoSymlink(`${base}.diff`).catch(() => undefined);
    const transcript = await readTextNoSymlink(`${base}.transcript.log`).catch(() => undefined);
    stages.push({
      record,
      ...(diff !== undefined ? { diff } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
    });
  }

  stages.sort((a, b) => {
    const sa = a.record.stage;
    const sb = b.record.stage;
    if (sa === sb) return 0;
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const proofPath = join(taskDir, `${sanitizeTimestamp(timestamp)}.proof.json`);
  let proof: Proof | undefined;
  try {
    proof = JSON.parse(await readFile(proofPath, 'utf8')) as Proof;
  } catch {
    proof = undefined;
  }

  return {
    taskId,
    timestamp,
    stages,
    ...(proof !== undefined ? { proof } : {}),
  };
}
