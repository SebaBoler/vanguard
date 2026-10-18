import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { Commands } from '../wire';
import {
  projects,
  runs,
  runDetail,
  activeRuns,
  session,
  appConfig,
  remoteRuns,
  boardTasks,
  capabilities,
  repoFlows,
  repoProviders,
  flowDoc,
  createdTask,
  dirListing,
  remoteImport,
} from './fixtures';

const READ_DRAFT = JSON.stringify({ id: 'draft-001', title: 'Draft task', body: 'Some draft content here.' });

/**
 * Fixture backend for the browser dev build, typed against the wire catalogue (S7): every key must
 * name a command, and every handler must return THAT command's result shape — a fixture that drifts
 * from the real backend's payload is a `tsc` error here (see mockBackend.test.ts for the exact
 * error a wrong return type produces), not a UI that renders convincingly against a shape no
 * backend sends. `Partial` because a browser build may legitimately stub only part of the surface;
 * the coverage guard in mockBackend.test.ts is what requires every command ipc.ts calls.
 *
 * Handlers take their args as `| undefined`: mockIPC passes whatever the caller sent, and the
 * wrappers in ipc.ts omit the record entirely for no-arg commands.
 */
const commandHandlers = {
  list_runs: () => runs,
  read_run: () => runDetail,
  list_projects: () => projects,
  add_project: (args: { path?: string } | undefined) => {
    const { path = '/dev/null' } = args ?? {};
    return [
      ...projects,
      { path, name: path.split('/').pop() ?? 'new-project', runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 },
    ];
  },
  remove_project: (args: { path?: string } | undefined) => {
    const { path } = args ?? {};
    return projects.filter((p) => p.path !== path);
  },
  list_active: () => activeRuns,
  read_session: () => session,
  read_app_config: () => appConfig,
  read_app_config_strict: () => appConfig,
  write_app_config: () => undefined,
  list_remote_runs: () => remoteRuns,
  import_remote_run: (args: { runId?: number } | undefined) => {
    const { runId = remoteImport.runId } = args ?? {};
    return { ...remoteImport, runId };
  },
  list_tasks: () => ({ tasks: boardTasks, capped: false }),
  fetch_spec: () => ({ spec: '## Task\n\nFix the login bug when the JWT token expires after inactivity.\n\n**Acceptance criteria:**\n- [ ] Login still works after token refresh\n- [ ] Tests pass\n- [ ] No regressions in the auth flow\n' }),
  list_spawns: () => [],
  spawn_run: () => 42,
  kill_run: () => undefined,
  watch_project: () => undefined,
  unwatch_project: () => undefined,
  api_capabilities: () => capabilities,
  api_create_run: () => ({ prUrl: undefined, secretBlocked: false }),
  api_complete: () => ({ text: 'Here is my analysis of the requested change. The implementation looks sound.' }),
  api_cancel_complete: () => undefined,
  api_create_task: () => createdTask,
  list_drafts: () => ['draft-001'],
  read_draft: () => READ_DRAFT,
  write_draft: () => undefined,
  delete_draft: () => undefined,
  // Editor UX 7/7 (composer attachments + mentions).
  api_list_repo_files: () => ({
    files: ['src/App.tsx', 'src/main.tsx', 'apps/desktop/README.md', 'package.json'],
    capped: false,
  }),
  api_read_repo_file: (args: { path?: string } | undefined) => {
    const { path = 'src/App.tsx' } = args ?? {};
    return { path, content: `// mock content of ${path}\nexport const answer = 42;\n`, truncated: false };
  },
  write_draft_asset: (args: { id?: string; name?: string } | undefined) => {
    const { id = 'draft-001', name = 'pic.png' } = args ?? {};
    return `/mock/.vanguard/drafts/${id}-assets/${name}`;
  },
  clear_draft_assets: () => undefined,
  api_list_flows: () => ({ flows: repoFlows }),
  api_list_providers: () => ({ providers: repoProviders }),
  api_read_flow: () => ({ doc: flowDoc, source: 'flow "plan-implement-review" {\n  label = "Plan → Implement → Review"\n\n  stage "planner" {}\n  stage "implement" { max_turns = 40 }\n  stage "reviewer" {}\n}\n' }),
  api_write_flow: () => ({ source: '' }),
  api_delete_flow: () => undefined,
  api_active_run: () => null,
  api_run_backlog: () => [],
  api_cancel: () => undefined,
  api_repo_ok: () => true,
  // Hub-only command (apps/desktop never reaches it through Tauri, but the browser dev build —
  // no Tauri runtime, hub marker absent — still needs a fixture so RepoPicker is drivable via the
  // mock backend, and so the ipc.ts coverage guard below passes).
  browse_dirs: () => dirListing,
} satisfies Partial<{
  [K in keyof Commands]: (args: Commands[K]['args']) => Promise<Commands[K]['result']> | Commands[K]['result'];
}>;

/** Tauri PLUGIN ipc the webview also makes (dialog, event) — not wire commands, so they sit outside
 * the catalogue-checked map above. */
const pluginHandlers = {
  'plugin:dialog|open': () => '/home/user/projects/new-project',
  'plugin:event|listen': () => 1,
  'plugin:event|unlisten': () => null,
};

// mockIPC dispatches by string name, so this is the one place the per-command arg types are erased.
const handlers = { ...commandHandlers, ...pluginHandlers } as Record<string, (args: unknown) => unknown>;

export const HANDLED_COMMANDS: readonly string[] = Object.keys(handlers);

/** Answer one command from the fixture table. Exposed so a hub-mode test can serve
 *  `POST /rpc/<cmd>` from the same fixtures `install()` serves over Tauri. */
export function handle(cmd: string, args: unknown): unknown {
  const handler = handlers[cmd];
  if (handler) return handler(args);
  console.warn(`[mockBackend] unhandled IPC command: ${cmd}`);
  return undefined;
}

export function install(): void {
  mockWindows('main');
  mockIPC(handle);
}
