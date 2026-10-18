// Thin forwarding shim: the on-disk run-record format — naming, writing, listing (fingerprint-cached),
// reading (incl. the closest-proof fallback) and the fingerprint itself — all live in
// src/core/run-store.ts now. This file only re-exports under the hub's historical names, so
// src/hub/rpc.ts, watch.ts, remote.ts and projects.ts keep importing from './runs.js' unchanged.
import { fingerprint, fnv1a, isRunRecordFile, listRuns, readRun, readTextNoSymlink, runsRoot, sanitizeTimestamp } from '../core/run-store.js';

export type { AgentUsage, Proof, RunDetail, RunRecord, RunSummary, StageDetail, VisualProof, VisualProofArtifact } from '../wire.js';

export { fnv1a, isRunRecordFile, readTextNoSymlink, sanitizeTimestamp };

/** `<runsRoot>` is the directory directly containing per-task subdirectories. */
export function defaultRunsRoot(repoPath: string): string {
  return runsRoot(repoPath);
}

/** Per-task subdirectories under an imported CI run's remote-runs tree. */
export function remoteRunsRoot(repoPath: string, remoteRunId: number): string {
  return runsRoot(repoPath, remoteRunId);
}

export const runsFingerprint = fingerprint;
export const listRunSummaries = listRuns;
export const readRunDetail = readRun;
