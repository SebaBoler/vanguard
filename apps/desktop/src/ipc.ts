import { invoke } from '@tauri-apps/api/core';
import type { RunSummary, RunDetail, Project } from './vanguard-output';

export function listRuns(repoPath: string): Promise<RunSummary[]> {
  return invoke<RunSummary[]>('list_runs', { repoPath });
}

export function readRun(repoPath: string, taskId: string, timestamp: string): Promise<RunDetail> {
  return invoke<RunDetail>('read_run', { repoPath, taskId, timestamp });
}

export function listProjects(): Promise<Project[]> {
  return invoke<Project[]>('list_projects');
}

export function addProject(path: string): Promise<Project[]> {
  return invoke<Project[]>('add_project', { path });
}

export function removeProject(path: string): Promise<Project[]> {
  return invoke<Project[]>('remove_project', { path });
}
