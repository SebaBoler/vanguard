import { invoke } from '@tauri-apps/api/core';
import type {
  RunSummary,
  RunDetail,
  Project,
  ActiveRun,
  SessionRead,
  RemoteRun,
  AppConfig,
  Task,
} from './vanguard-output';

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

export function readAppConfig(repoPath: string): Promise<AppConfig> {
  return invoke<AppConfig>('read_app_config', { repoPath });
}

export function writeAppConfig(repoPath: string, config: AppConfig): Promise<void> {
  return invoke<void>('write_app_config', { repoPath, config });
}

export function listRemoteRuns(repoPath: string): Promise<RemoteRun[]> {
  return invoke<RemoteRun[]>('list_remote_runs', { repoPath });
}

export function listTasks(repoPath: string): Promise<Task[]> {
  return invoke<Task[]>('list_tasks', { repoPath });
}

export function fetchSpec(repoPath: string, taskId: string): Promise<string> {
  return invoke<string>('fetch_spec', { repoPath, taskId });
}

export const SPAWN_OUTPUT_EVENT = 'spawn:output';
export const SPAWN_EXIT_EVENT = 'spawn:exit';

export interface SpawnInfo {
  pid: number;
  cwd: string;
  command: string;
}

export function listSpawns(): Promise<SpawnInfo[]> {
  return invoke<SpawnInfo[]>('list_spawns');
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

// Typed core API over the `vanguard __sidecar` child (no stdout scraping). Run events arrive on the
// `api:event` Tauri channel — subscribe with `listen('api:event', …)` where the run UI needs them
// (that consumption is Subsystem 1; this only exposes the wrappers).
export interface Capabilities {
  providers: string[];
  flows: { name: string; label: string }[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

export interface CreateRunParams {
  issueRef: string;
  /** Absolute path to the target project repo — required (the sidecar child has no project cwd). */
  repoPath: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
}

export function apiCapabilities(): Promise<Capabilities> {
  return invoke<Capabilities>('api_capabilities');
}

// capabilities() is pure and never changes in a session — cache it once so a live run's held proc
// mutex (api_create_run) never blocks the New Run form's populate call.
let capsCache: Promise<Capabilities> | undefined;
export function apiCapabilitiesCached(): Promise<Capabilities> {
  capsCache ??= apiCapabilities();
  return capsCache;
}

export function apiCreateRun(params: CreateRunParams): Promise<{ prUrl?: string; secretBlocked?: boolean }> {
  return invoke('api_create_run', { params });
}

/** Doc-editor chat completion (Subsystem 3). One-shot spawn, never the run mutex. */
export interface CompleteParams {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}
export function apiComplete(params: CompleteParams): Promise<{ text?: string; error?: { message: string } }> {
  return invoke('api_complete', { req: params });
}

export function listDocs(repoPath: string): Promise<string[]> {
  return invoke<string[]>('list_docs', { repoPath });
}
export function readDoc(repoPath: string, name: string): Promise<string> {
  return invoke<string>('read_doc', { repoPath, name });
}
export function writeDoc(repoPath: string, name: string, content: string): Promise<void> {
  return invoke<void>('write_doc', { repoPath, name, content });
}

/** The in-flight typed run's id, or null when idle. */
export function apiActiveRun(): Promise<string | null> {
  return invoke<string | null>('api_active_run');
}

/** Buffered `{ runId, event }` backlog for a run, for a re-attaching live strip. */
export function apiRunBacklog(runId: string): Promise<unknown[]> {
  return invoke<unknown[]>('api_run_backlog', { runId });
}

/** Cancel the in-flight typed run (out-of-band SIGUSR2 to the sidecar child). */
export function apiCancel(): Promise<void> {
  return invoke<void>('api_cancel');
}

/** Click-time pre-flight: is `repoPath` a git work tree? */
export function apiRepoOk(repoPath: string): Promise<boolean> {
  return invoke<boolean>('api_repo_ok', { repoPath });
}
