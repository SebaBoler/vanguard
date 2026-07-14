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
  /** Stage-library names — the flow editor's palette. Static per session, like everything here. */
  stages: string[];
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

// capabilities() is pure and never changes in a session, so cache it — one fewer IPC round-trip on
// every mount. It is NO LONGER a workaround for the run mutex: capabilities now goes over the sidecar's
// query pipe, which answers while a run holds the run pipe. (It used to be exactly that workaround, and
// the comment said so — leaving that claim here would have someone "simplify" the cache away on the
// belief that the block it dodged still exists, or keep it for a reason that is no longer true.)
let capsCache: Promise<Capabilities> | undefined;
export function apiCapabilitiesCached(): Promise<Capabilities> {
  // Cache successes only: `??=` would pin a REJECTED promise for the whole session (a sidecar
  // that was briefly unavailable at startup would permanently disable everything caps-gated —
  // the flow editor's create form, the palette — with no recovery short of an app restart).
  capsCache ??= apiCapabilities().catch((err: unknown) => {
    capsCache = undefined;
    throw err;
  });
  return capsCache;
}

export function apiCreateRun(params: CreateRunParams): Promise<{ prUrl?: string; secretBlocked?: boolean }> {
  return invoke('api_create_run', { params });
}

/**
 * Doc-editor chat completion (Subsystem 3). One-shot spawn, never the run mutex.
 *
 * No `baseUrl` here on purpose: the completion runs with the inherited Anthropic credential, so a
 * caller-supplied base URL would be a way for anything running in the webview to redirect that token
 * to a host of its choosing. Rust reads `chatBaseUrl` from `app.json` itself — hence `repoPath`.
 */
export interface CompleteParams {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model: string;
}
export function apiComplete(
  repoPath: string,
  params: CompleteParams,
): Promise<{ text?: string; error?: { message: string } }> {
  return invoke('api_complete', { repoPath, req: params });
}

/**
 * Create a task on the configured transport. The app's first WRITE to an external system, and it cannot
 * be undone from here — so the caller must confirm first, and it must never fire as a side effect.
 *
 * Only title/body cross: `source`, `team` and `label` are read from app.json in Rust. The renderer does
 * not choose which tracker gets written to. (Same rule as CompleteParams — and it matters more here.)
 */
export function apiCreateTask(repoPath: string, title: string, body: string): Promise<{ id: string; url: string }> {
  return invoke('api_create_task', { repoPath, title, body });
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

// Flow-file editing (S5). Hand-mirrors of src/flows/types.ts + src/flows/repo.ts — same
// manual-mirror discipline as RunEvent; the shared-types seam is backlog.
export interface StageOverrides {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns?: number;
  provider?: string;
  resumePrevious?: boolean;
}
export interface StageDecl {
  name: string;
  /** `"relpath#export"` under `.vanguard/` — the Layer-2 escape hatch. */
  ref?: string;
  overrides: StageOverrides;
  meta?: Record<string, unknown>;
}
export interface LoopDecl {
  stages: string[];
  until: string;
  max: number;
}
export interface FlowDoc {
  name: string;
  label: string;
  stages: StageDecl[];
  loops: LoopDecl[];
  meta?: Record<string, unknown>;
}
/** One discovered flow file. `name` present ⇔ parsed (openable); `error` present ⇔ not runnable. */
export interface RepoFlowInfo {
  file: string;
  name?: string;
  label?: string;
  error?: string;
}

export function apiListFlows(repoPath: string): Promise<{ flows: RepoFlowInfo[] }> {
  return invoke('api_list_flows', { repoPath });
}

/** One configured custom provider (S6): healthy (name, no error) or broken (`error` set; index -1 =
 *  whole-file pseudo-entry). `error` absent ⇔ runnable. Names only — no baseUrl/keyEnv on the wire. */
export interface RepoProviderInfo {
  index: number;
  name?: string;
  error?: string;
}

/** Fresh per mount, like apiListFlows — a provider saved in Settings must be runnable immediately. */
export function apiListProviders(repoPath: string): Promise<{ providers: RepoProviderInfo[] }> {
  return invoke('api_list_providers', { repoPath });
}

/** `source` is the raw file bytes on read; the canonical form appears only after a write. */
export function apiReadFlow(repoPath: string, file: string): Promise<{ doc: FlowDoc; source: string }> {
  return invoke('api_read_flow', { repoPath, file });
}

export function apiWriteFlow(repoPath: string, file: string, doc: FlowDoc): Promise<{ source: string }> {
  return invoke('api_write_flow', { repoPath, file, doc });
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
