import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
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
} from './fixtures';

const READ_DRAFT = JSON.stringify({ id: 'draft-001', title: 'Draft task', body: 'Some draft content here.' });

const handlers: Record<string, (args: unknown) => unknown> = {
  list_runs: () => runs,
  read_run: () => runDetail,
  list_projects: () => projects,
  add_project: (args) => {
    const { path = '/dev/null' } = (args ?? {}) as { path?: string };
    return [
      ...projects,
      { path, name: path.split('/').pop() ?? 'new-project', runCount: 0, taskCount: 0, totalCostUsd: 0, failedCount: 0, runningCount: 0, runsLast24h: 0 },
    ];
  },
  remove_project: (args) => {
    const { path } = (args ?? {}) as { path?: string };
    return projects.filter((p) => p.path !== path);
  },
  list_active: () => activeRuns,
  read_session: () => session,
  read_app_config: () => appConfig,
  read_app_config_strict: () => appConfig,
  write_app_config: () => null,
  list_remote_runs: () => remoteRuns,
  list_tasks: () => ({ tasks: boardTasks, capped: false }),
  fetch_spec: () => ({ spec: '## Task\n\nFix the login bug when the JWT token expires after inactivity.\n\n**Acceptance criteria:**\n- [ ] Login still works after token refresh\n- [ ] Tests pass\n- [ ] No regressions in the auth flow\n' }),
  list_spawns: () => [],
  spawn_run: () => 42,
  kill_run: () => null,
  watch_project: () => null,
  unwatch_project: () => null,
  api_capabilities: () => capabilities,
  api_create_run: () => ({ prUrl: undefined, secretBlocked: false }),
  api_complete: () => ({ text: 'Here is my analysis of the requested change. The implementation looks sound.' }),
  api_cancel_complete: () => null,
  api_create_task: () => createdTask,
  list_drafts: () => ['draft-001'],
  read_draft: () => READ_DRAFT,
  write_draft: () => null,
  delete_draft: () => null,
  api_list_flows: () => ({ flows: repoFlows }),
  api_list_providers: () => ({ providers: repoProviders }),
  api_read_flow: () => ({ doc: flowDoc, source: 'flow "plan-implement-review" {\n  label = "Plan → Implement → Review"\n\n  stage "planner" {}\n  stage "implement" { max_turns = 40 }\n  stage "reviewer" {}\n}\n' }),
  api_write_flow: () => ({ source: '' }),
  api_delete_flow: () => null,
  api_active_run: () => null,
  api_run_backlog: () => [],
  api_cancel: () => null,
  api_repo_ok: () => true,
  'plugin:dialog|open': () => '/home/user/projects/new-project',
  'plugin:event|listen': () => 1,
  'plugin:event|unlisten': () => null,
};

export const HANDLED_COMMANDS: readonly string[] = Object.keys(handlers);

export function install(): void {
  mockWindows('main');
  mockIPC((cmd, args) => {
    const handler = handlers[cmd];
    if (handler) return handler(args);
    console.warn(`[mockBackend] unhandled IPC command: ${cmd}`);
    return undefined;
  });
}
