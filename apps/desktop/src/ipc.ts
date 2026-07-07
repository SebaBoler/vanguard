import { invoke } from '@tauri-apps/api/core';
import type { RunSummary, RunDetail } from './vanguard-output';

export function listRuns(repoPath: string): Promise<RunSummary[]> {
  return invoke<RunSummary[]>('list_runs', { repoPath });
}

export function readRun(repoPath: string, taskId: string, timestamp: string): Promise<RunDetail> {
  return invoke<RunDetail>('read_run', { repoPath, taskId, timestamp });
}
