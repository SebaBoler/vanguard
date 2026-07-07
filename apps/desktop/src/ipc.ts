import { invoke } from '@tauri-apps/api/core';
import type { RunSummary, RunDetail, Project, ActiveRun, SessionRead, RemoteRun } from './vanguard-output';

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

export function listActive(repoPath: string): Promise<ActiveRun[]> {
  return invoke<ActiveRun[]>('list_active', { repoPath });
}

export function readSession(sessionFile: string): Promise<SessionRead> {
  return invoke<SessionRead>('read_session', { sessionFile });
}

export function listRemoteRuns(repoPath: string): Promise<RemoteRun[]> {
  return invoke<RemoteRun[]>('list_remote_runs', { repoPath });
}

export function fetchSpec(repoPath: string, taskId: string): Promise<string> {
  return invoke<string>('fetch_spec', { repoPath, taskId });
}

export function spawnRun(cwd: string, command: string): Promise<number> {
  return invoke<number>('spawn_run', { cwd, command });
}

export function killRun(pid: number): Promise<void> {
  return invoke<void>('kill_run', { pid });
}

export function watchProject(repoPath: string): Promise<void> {
  return invoke<void>('watch_project', { repoPath });
}

export function unwatchProject(repoPath: string): Promise<void> {
  return invoke<void>('unwatch_project', { repoPath });
}
