import { invoke } from '@tauri-apps/api/core';
import type {
  RunSummary,
  RunDetail,
  Project,
  ActiveRun,
  SessionRead,
  RemoteRun,
  AppConfig,
} from './vanguard-output';
import type { BoardTask } from './wire';

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

/** Settings' read (S6 guard b): rejects when app.json exists but does not parse — the passive
 *  readAppConfig collapses that to defaults, which is right for chat/board and WRONG for a form
 *  that will write the whole object back. */
export function readAppConfigStrict(repoPath: string): Promise<AppConfig> {
  return invoke<AppConfig>('read_app_config_strict', { repoPath });
}

export function writeAppConfig(repoPath: string, config: AppConfig): Promise<void> {
  return invoke<void>('write_app_config', { repoPath, config });
}

export function listRemoteRuns(repoPath: string): Promise<RemoteRun[]> {
  return invoke<RemoteRun[]>('list_remote_runs', { repoPath });
}

/** Board read path (S9): served by core over the sidecar query pipe; capped drives the banner. */
export function listTasks(repoPath: string): Promise<{ tasks: BoardTask[]; capped: boolean }> {
  return invoke<{ tasks: BoardTask[]; capped: boolean }>('list_tasks', { repoPath });
}

export async function fetchSpec(repoPath: string, taskId: string): Promise<string> {
  const { spec } = await invoke<{ spec: string }>('fetch_spec', { repoPath, taskId });
  return spec;
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
// Wire types come from the GENERATED src/wire.ts (S7) — no more hand-mirrors. Feature code keeps
// importing them from this module.
export type {
  BoardTask,
  Capabilities,
  FlowInfo,
  CreateRunParams,
  CreateRunResult,
  StageOverrides,
  StageDecl,
  LoopDecl,
  FlowDoc,
  RepoFlowInfo,
  RepoProviderInfo,
  CreatedTask,
  Finding,
} from './wire';
import type { Capabilities, CreateRunParams, CreateRunResult, FlowDoc, RepoFlowInfo, RepoProviderInfo, CompleteRequest } from './wire';

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

export function apiCreateRun(params: CreateRunParams): Promise<CreateRunResult> {
  return invoke('api_create_run', { params });
}

/**
 * Doc-editor chat completion (Subsystem 3). One-shot spawn, never the run mutex.
 *
 * No `baseUrl` here on purpose: the completion runs with the inherited Anthropic credential, so a
 * caller-supplied base URL would be a way for anything running in the webview to redirect that token
 * to a host of its choosing. Rust reads `chatBaseUrl` from `app.json` itself — hence `repoPath`.
 */
// ALLOWLIST, deliberately not Omit<CompleteRequest,...>: every field here is one the renderer is
// permitted to send. A new CompleteRequest field must be added HERE to cross the webview boundary
// (a denylist would auto-expose it — review #342). Field types still derive from wire (no drift).
export interface CompleteParams {
  system?: CompleteRequest['system'];
  messages: CompleteRequest['messages'];
  model: string;
  /** Pasted images + inlined text files/mentions (Editor UX 7/7). Bounded host-side before send. */
  attachments?: CompleteRequest['attachments'];
}
export function apiComplete(
  repoPath: string,
  params: CompleteParams,
  // Opaque per-turn handle. When present, Rust tracks the spawned `__complete` child under it so
  // `apiCancelComplete(callId)` can kill exactly this turn (the Stop button). Omitted for
  // fire-and-forget completions (the auto-title) that are never cancelled.
  callId?: string,
): Promise<{ text?: string; error?: { message: string } }> {
  return invoke('api_complete', { repoPath, req: params, callId });
}

/**
 * Stop an in-flight doc-chat completion (Editor UX 5/7): kill the `__complete` child that
 * `apiComplete` spawned for this `callId`. Kill-by-id is the whole surface — it cannot touch the run
 * sidecar. An unknown/finished id is a silent no-op.
 */
export function apiCancelComplete(callId: string): Promise<void> {
  return invoke<void>('api_cancel_complete', { callId });
}

/**
 * Create a task on the configured transport. The app's first WRITE to an external system, and it cannot
 * be undone from here — so the caller must confirm first, and it must never fire as a side effect.
 *
 * Only title/body cross: `source`, `team` and `label` are read from app.json in Rust. The renderer does
 * not choose which tracker gets written to. (Same rule as CompleteParams — and it matters more here.)
 */
export function apiCreateTask(repoPath: string, title: string, body: string): Promise<import('./wire').CreatedTask> {
  return invoke('api_create_task', { repoPath, title, body });
}

/** Composer `@`-mention autocomplete (Editor UX 7/7): the project repo's tracked files, capped. */
export function apiListRepoFiles(repoPath: string): Promise<{ files: string[]; capped: boolean }> {
  return invoke('api_list_repo_files', { repoPath });
}

/** Read one tracked file for mention inlining (Editor UX 7/7); `path` is repo-relative, capped read. */
export function apiReadRepoFile(repoPath: string, path: string): Promise<{ path: string; content: string; truncated: boolean }> {
  return invoke('api_read_repo_file', { repoPath, path });
}

/** Persist a pasted image under the draft's assets dir (Editor UX 7/7); returns its absolute path. */
export function writeDraftAsset(repoPath: string, id: string, name: string, bytes: Uint8Array): Promise<string> {
  return invoke<string>('write_draft_asset', { repoPath, id, name, bytes: Array.from(bytes) });
}

// Task drafts (S10): one JSON file per draft under `.vanguard/drafts/`; the webview owns the shape
// (see features/task/draftStore.ts), Rust is dumb storage.
export function listDrafts(repoPath: string): Promise<string[]> {
  return invoke<string[]>('list_drafts', { repoPath });
}
export function readDraft(repoPath: string, id: string): Promise<string> {
  return invoke<string>('read_draft', { repoPath, id });
}
export function writeDraft(repoPath: string, id: string, content: string): Promise<void> {
  return invoke<void>('write_draft', { repoPath, id, content });
}
export function deleteDraft(repoPath: string, id: string): Promise<void> {
  return invoke<void>('delete_draft', { repoPath, id });
}

// Flow-file editing (S5). Types now come from the generated wire (S7).
export function apiListFlows(repoPath: string): Promise<{ flows: RepoFlowInfo[] }> {
  return invoke('api_list_flows', { repoPath });
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

/** Delete one flow file (S8). Idempotent — an already-deleted file succeeds. */
export function apiDeleteFlow(repoPath: string, file: string): Promise<void> {
  return invoke('api_delete_flow', { repoPath, file });
}

/** The in-flight typed run `{runId, repoPath}`, or null when idle. repoPath scopes re-attach to
 *  the owning project (S8 — the sidecar is global, Inspectors are per-project). */
export function apiActiveRun(): Promise<{ runId: string; repoPath: string } | null> {
  return invoke<{ runId: string; repoPath: string } | null>('api_active_run');
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
