import type {
  RunSummary,
  RunDetail,
  Project,
  ActiveRun,
  SessionRead,
  AppConfig,
  RemoteRun,
  RunRecord,
} from '../vanguard-output';
import type {
  Capabilities,
  BoardTask,
  RepoFlowInfo,
  RepoProviderInfo,
  FlowDoc,
  CreatedTask,
} from '../wire';

const REPO_PATH = '/home/user/projects/my-app';
const REPO_PATH_2 = '/home/user/projects/api-service';

export const projects: Project[] = [
  {
    path: REPO_PATH,
    name: 'my-app',
    runCount: 42,
    taskCount: 7,
    totalCostUsd: 12.34,
    failedCount: 3,
    lastRun: '2026-07-14T10:30:00.000Z',
    runningCount: 1,
    runsLast24h: 5,
    color: '#4f46e5',
  },
  {
    path: REPO_PATH_2,
    name: 'api-service',
    runCount: 18,
    taskCount: 2,
    totalCostUsd: 4.56,
    failedCount: 0,
    lastRun: '2026-07-13T15:20:00.000Z',
    runningCount: 0,
    runsLast24h: 2,
    color: '#059669',
  },
];

export const runs: RunSummary[] = [
  {
    taskId: 'task-001',
    timestamp: '2026-07-14T10:30:00.000Z',
    stages: ['planner', 'implement', 'reviewer'],
    totalCostUsd: 0.28,
    anyFailed: false,
    prUrl: 'https://github.com/org/my-app/pull/123',
  },
  {
    taskId: 'task-002',
    timestamp: '2026-07-14T09:00:00.000Z',
    stages: ['implement'],
    totalCostUsd: 0.12,
    anyFailed: false,
  },
  {
    taskId: 'task-003',
    timestamp: '2026-07-13T18:45:00.000Z',
    stages: ['planner', 'implement'],
    totalCostUsd: 0.35,
    anyFailed: true,
  },
];

const baseRecord: RunRecord = {
  taskId: 'task-001',
  completed: true,
  exitReason: 'complete',
  turns: 12,
  sessionId: 'sess-abc123',
  worktreePath: `${REPO_PATH}/.vanguard/worktrees/task-001`,
  worktreePreserved: false,
  finalText: 'Implemented the requested feature successfully.',
  usage: { inputTokens: 45000, outputTokens: 8200, cacheReadInputTokens: 12000 },
  costUsd: 0.28,
  cacheEfficiency: 0.27,
  durationMs: 180000,
  model: 'claude-sonnet-4-6',
  timestamp: '2026-07-14T10:30:00.000Z',
  prUrl: 'https://github.com/org/my-app/pull/123',
};

const lines = (...entries: object[]): string => entries.map((e) => JSON.stringify(e)).join('\n');

const PLANNER_TRANSCRIPT = lines(
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll plan the implementation. Let me read the relevant files first." }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/App.tsx' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: "import React from 'react';\n// ... file contents ..." }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is my plan:\n1. Add the new endpoint\n2. Update type definitions\n3. Write tests\n4. Open a pull request' }] } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.04 },
);

const IMPLEMENT_TRANSCRIPT = lines(
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Implementing the changes per the plan.' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/App.tsx', description: 'Add new feature' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Edit applied successfully.' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '✓ 42 tests passed' }] } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.18 },
);

const REVIEWER_TRANSCRIPT = lines(
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewing the changes for correctness and style.' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The implementation looks correct. Tests pass. Opening a pull request.' }] } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.06 },
);

export const runDetail: RunDetail = {
  taskId: 'task-001',
  timestamp: '2026-07-14T10:30:00.000Z',
  stages: [
    {
      record: { ...baseRecord, stage: 'planner', turns: 4, costUsd: 0.04 },
      transcript: PLANNER_TRANSCRIPT,
    },
    {
      record: { ...baseRecord, stage: 'implement', turns: 6, costUsd: 0.18 },
      diff: `--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,4 +1,5 @@\n import React from 'react';\n+import { useState } from 'react';\n \n export default function App() {\n`,
      transcript: IMPLEMENT_TRANSCRIPT,
    },
    {
      record: { ...baseRecord, stage: 'reviewer', turns: 2, costUsd: 0.06 },
      transcript: REVIEWER_TRANSCRIPT,
    },
  ],
  proof: {
    command: 'pnpm test',
    exitCode: 0,
    passed: true,
    sha256: 'abc123def456789012345678901234567890abcd',
    outputTail: '✓ 42 tests passed in 3.2s',
  },
};

export const activeRuns: ActiveRun[] = [
  {
    taskId: 'task-active-001',
    sessionFile: `${REPO_PATH}/.vanguard/sessions/task-active-001.jsonl`,
    lastActivityMs: 1752530000000,
  },
];

export const session: SessionRead = {
  entries: [
    { role: 'assistant', text: 'I will help you implement this feature. Let me start by reading the relevant files.' },
    { role: 'tool', text: 'Read file: src/index.ts\n---\nexport default {};\n' },
    { role: 'assistant', text: 'Here is my plan:\n1. Add the new endpoint\n2. Update types\n3. Write tests' },
  ],
  inputTokens: 15000,
  outputTokens: 3200,
  cacheReadTokens: 4000,
  estCostUsd: 0.09,
};

export const appConfig: AppConfig = {
  source: 'github',
  label: 'my-app',
  team: 'platform',
  color: '#4f46e5',
  provider: 'claude',
  reviewProvider: 'claude',
  verifyCmd: 'pnpm test',
  concurrency: 2,
  budgetUsd: 10,
  runCommand: 'pnpm dev',
  chatModel: 'claude-sonnet-4-6',
};

export const remoteRuns: RemoteRun[] = [
  {
    id: 12345,
    status: 'completed',
    conclusion: 'success',
    title: 'Fix login bug [LINEAR-123]',
    branch: 'feat/fix-login',
    workflow: 'vanguard.yml',
    createdAt: '2026-07-14T08:00:00.000Z',
    event: 'workflow_dispatch',
    url: 'https://github.com/org/my-app/actions/runs/12345',
  },
  {
    id: 12344,
    status: 'completed',
    conclusion: 'failure',
    title: 'Add dark mode [LINEAR-456]',
    branch: 'feat/dark-mode',
    workflow: 'vanguard.yml',
    createdAt: '2026-07-13T14:00:00.000Z',
    event: 'workflow_dispatch',
    url: 'https://github.com/org/my-app/actions/runs/12344',
  },
];

export const boardTasks: BoardTask[] = [
  { id: 'LINEAR-123', title: 'Fix login bug when token expires', column: 'done', state: 'Done' },
  { id: 'LINEAR-124', title: 'Add dark mode support', column: 'running', state: 'In Progress' },
  { id: 'LINEAR-125', title: 'Improve search performance', column: 'queued', state: 'Backlog' },
  { id: 'LINEAR-126', title: 'Refactor auth middleware', column: 'review', state: 'In Review' },
];

export const capabilities: Capabilities = {
  providers: ['claude', 'codex', 'cursor'],
  flows: [
    { name: 'default', label: 'Default' },
    { name: 'plan-implement-review', label: 'Plan → Implement → Review' },
    { name: 'quick-fix', label: 'Quick Fix' },
  ],
  stages: ['planner', 'implement', 'reviewer', 'adversary', 'verify'],
  transports: ['github', 'linear'],
  defaults: {
    provider: 'claude',
    maxTurns: 30,
    maxCostUsd: 5,
    baseBranch: 'main',
  },
};

export const repoFlows: RepoFlowInfo[] = [
  { file: '.vanguard/flows/plan-implement-review.hcl', name: 'plan-implement-review', label: 'Plan → Implement → Review' },
  { file: '.vanguard/flows/quick-fix.hcl', name: 'quick-fix', label: 'Quick Fix' },
];

export const repoProviders: RepoProviderInfo[] = [
  { index: 0, name: 'my-openrouter' },
];

export const flowDoc: FlowDoc = {
  name: 'plan-implement-review',
  label: 'Plan → Implement → Review',
  stages: [
    { name: 'planner', overrides: {} },
    { name: 'implement', overrides: { maxTurns: 40 } },
    { name: 'reviewer', overrides: {} },
  ],
  loops: [],
};

export const createdTask: CreatedTask = {
  id: 'LINEAR-999',
  url: 'https://linear.app/org/issue/LINEAR-999',
};
