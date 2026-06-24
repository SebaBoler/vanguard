# GitLab Task Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitLab as a first-class task source — mirroring GitHub's issue automation, watch loop, loop-v1, and MR review capabilities.

**Architecture:** A new `GitLabTaskFetcher` (backed by the `glab` CLI) implements the existing `TaskFetcher` interface. GitLab watch and spec primitives mirror the GitHub ones but use scoped labels (`vanguard::running`, `vanguard::review`, `vanguard::speccing`) because GitLab makes labels in the same `::` scope mutually exclusive, removing the need to manually remove the prior state label. New `review-mr`, `watch-mrs`, and `doctor-mrs` commands mirror `review-pr`, `watch-prs`, and `doctor-prs` using `glab mr` subcommands. A single `cli?: 'gh' | 'glab'` option in `PublishOptions` lets `publishForReview` create either a GitHub PR or a GitLab MR.

**Tech Stack:** TypeScript strict, ESM (`.js` imports), Node 24+, Vitest, `execa`, `glab` CLI.

## Global Constraints

- Strict TypeScript; explicit `.js` import extensions on every local import.
- Vitest tests co-located as `*.test.ts`; run with `pnpm test`.
- `pnpm typecheck` must pass before any task is considered done.
- **Never touch `.github/workflows/`.**
- Match surrounding code density (minimal comments, no JSDoc on obvious things).
- GitLab scoped label defaults: claimed=`vanguard::running`, review=`vanguard::review`, specClaimed=`vanguard::speccing`, mrReviewing=`vanguard::reviewing`, mrReviewed=`vanguard::reviewed`.
- Loop-v1 routing label defaults (user-controlled): specLabel=`ready for spec`, agentLabel=`ready for agent`, needsInfoLabel=`needs info` — same as GitHub.
- CLI flag for watch/doctor: `--gitlab-project group/project` (NOT `--gitlab-repo`).
- CLI flag for run: `--gitlab group/project#iid`.
- MR review commands: `review-mr`, `watch-mrs`, `doctor-mrs`.
- `glab` is the only CLI tool used for GitLab operations; never use fetch/axios/node-fetch.

---

### Task 1: Label constants + `publishForReview` GitLab extension

**Files:**
- Create: `src/gitlab-labels.ts`
- Modify: `src/pipeline/pipeline.ts` (add `cli` option, lines ~667-691)
- Modify: `src/pipeline/pipeline.test.ts` (add `glab` coverage)

**Interfaces:**
- Consumes: `src/github-labels.ts` (pattern to copy exactly)
- Produces:
  - `GITLAB_CLAIMED_LABEL = 'vanguard::running'`
  - `GITLAB_REVIEW_LABEL = 'vanguard::review'`
  - `GITLAB_SPEC_CLAIMED_LABEL = 'vanguard::speccing'`
  - `GITLAB_MR_REVIEWING_LABEL = 'vanguard::reviewing'`
  - `GITLAB_MR_REVIEWED_LABEL = 'vanguard::reviewed'`
  - `PublishOptions.cli?: 'gh' | 'glab'` (default `'gh'`, backward-compatible)

- [ ] **Step 1: Write the failing test for `publishForReview` with `glab`**

Open `src/pipeline/pipeline.test.ts`. Find the existing `publishForReview` tests and add after them:

```typescript
it('publishForReview with glab calls glab mr create with gitlab flags', async () => {
  const calls: Array<[string, string[], string]> = [];
  const fakeRunner: PipelineRunner = async (cmd, args, cwd) => {
    calls.push([cmd, args, cwd]);
    if (cmd === 'glab' && args[0] === 'mr') return 'https://gitlab.com/owner/repo/-/merge_requests/1\n';
    return '';
  };
  const ctx = fakeContext('gl-test');
  const result = await publishForReview(ctx, {
    title: 'My MR',
    body: 'desc',
    draft: true,
    cli: 'glab',
    runner: fakeRunner,
  });
  const mrCall = calls.find(([cmd]) => cmd === 'glab');
  expect(mrCall).toBeDefined();
  expect(mrCall![1]).toContain('mr');
  expect(mrCall![1]).toContain('create');
  expect(mrCall![1]).toContain('--source-branch');
  expect(mrCall![1]).toContain('--target-branch');
  expect(mrCall![1]).toContain('--description');
  expect(mrCall![1]).toContain('--draft');
  expect(result.prUrl).toBe('https://gitlab.com/owner/repo/-/merge_requests/1');
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test src/pipeline/pipeline.test.ts
```
Expected: FAIL — `cli` is not a known option.

- [ ] **Step 3: Create `src/gitlab-labels.ts`**

```typescript
export const GITLAB_CLAIMED_LABEL = 'vanguard::running';
export const GITLAB_REVIEW_LABEL = 'vanguard::review';
export const GITLAB_SPEC_CLAIMED_LABEL = 'vanguard::speccing';
export const GITLAB_MR_REVIEWING_LABEL = 'vanguard::reviewing';
export const GITLAB_MR_REVIEWED_LABEL = 'vanguard::reviewed';
```

- [ ] **Step 4: Extend `PublishOptions` in `src/pipeline/pipeline.ts`**

Find the `PublishOptions` interface (just before `publishForReview`). Add one optional field:

```typescript
export interface PublishOptions {
  title: string;
  body?: string;
  draft?: boolean;
  baseBranch?: string;
  remote?: string;
  /** CLI tool to use for PR/MR creation. Default 'gh' (GitHub). Use 'glab' for GitLab MRs. */
  cli?: 'gh' | 'glab';
  runner?: PipelineRunner;
}
```

- [ ] **Step 5: Update `publishForReview` body to dispatch on `cli`**

Replace the `args` construction and `run('gh', ...)` call (currently at lines ~670-689) with:

```typescript
export async function publishForReview(ctx: RunContext, opts: PublishOptions): Promise<PublishOutcome> {
  const run = opts.runner ?? defaultRunner;
  const tool = opts.cli ?? 'gh';
  await run('git', ['push', '-u', opts.remote ?? 'origin', ctx.branch], ctx.worktreePath);
  let args: string[];
  if (tool === 'glab') {
    args = [
      'mr', 'create',
      '--source-branch', ctx.branch,
      '--target-branch', opts.baseBranch ?? 'main',
      '--title', opts.title,
      '--description', opts.body ?? '',
    ];
    if (opts.draft === true) args.push('--draft');
  } else {
    args = [
      'pr', 'create',
      '--head', ctx.branch,
      '--base', opts.baseBranch ?? 'main',
      '--title', opts.title,
      '--body', opts.body ?? '',
    ];
    if (opts.draft === true) args.push('--draft');
  }
  const out = await run(tool, args, ctx.worktreePath);
  const prUrl =
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('http'))
      .pop() ?? out.trim();
  return { branch: ctx.branch, prUrl };
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm test src/pipeline/pipeline.test.ts
```
Expected: all pass.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm typecheck
git add src/gitlab-labels.ts src/pipeline/pipeline.ts src/pipeline/pipeline.test.ts
git commit -m "feat(gitlab): label constants + publishForReview glab support"
```

---

### Task 2: `src/tasks/gitlab.ts` — GitLab TaskFetcher

**Files:**
- Create: `src/tasks/gitlab.ts`
- Create: `src/tasks/gitlab.test.ts`

**Interfaces:**
- Consumes: `TaskFetcher`, `Task`, `TaskComment`, `TaskFilter` from `./fetcher.js`
- Produces:
  - `GlabRunner = (args: string[]) => Promise<string>`
  - `defaultGlabRunner: GlabRunner`
  - `encodeProject(project: string): string` — replaces `/` with `%2F`
  - `issueIID(ref: string): string` — strips `group/project#` prefix
  - `GitLabIssue`, `GitLabNote` types
  - `GitLabTaskFetcher implements TaskFetcher`
  - `commentGitlabIssue(project, issueRef, body, glab?): Promise<void>`
  - `linkMergeRequest(project, issueRef, mrUrl, glab?): Promise<void>`
  - `editGitlabLabels(project, issueRef, labels, glab?): Promise<void>`

- [ ] **Step 1: Write failing tests for `issueIID` and `encodeProject`**

Create `src/tasks/gitlab.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { issueIID, encodeProject } from './gitlab.js';

describe('issueIID', () => {
  it('returns bare number unchanged', () => {
    expect(issueIID('42')).toBe('42');
  });
  it('strips group/project# prefix', () => {
    expect(issueIID('group/project#42')).toBe('42');
  });
  it('strips nested group prefix', () => {
    expect(issueIID('group/sub/project#7')).toBe('7');
  });
});

describe('encodeProject', () => {
  it('encodes slash to %2F', () => {
    expect(encodeProject('owner/project')).toBe('owner%2Fproject');
  });
  it('encodes all slashes in nested groups', () => {
    expect(encodeProject('group/sub/project')).toBe('group%2Fsub%2Fproject');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test src/tasks/gitlab.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/tasks/gitlab.ts`**

```typescript
import { execa } from 'execa';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';

export interface GitLabNote {
  id: number;
  body: string;
  author: { username: string };
  system: boolean;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
}

/** Runs a `glab` subcommand and returns its stdout. Injected so unit tests never call real glab. */
export type GlabRunner = (args: string[]) => Promise<string>;

export const defaultGlabRunner: GlabRunner = async (args: string[]): Promise<string> =>
  (await execa('glab', args)).stdout;

/** Strips an optional `group/project#` prefix, returning just the numeric IID part. */
export function issueIID(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

/** URL-encodes a GitLab project path for use in `glab api` calls (slashes → %2F). */
export function encodeProject(project: string): string {
  return project.replace(/\//g, '%2F');
}

function toGitLabTask(project: string, issue: GitLabIssue, notes: GitLabNote[] = []): Task {
  const comments: TaskComment[] = notes
    .filter((n) => !n.system)
    .map((n) => ({ author: n.author.username, body: n.body }));
  return {
    id: `${project}#${issue.iid}`,
    title: issue.title,
    description: issue.description ?? '',
    labels: issue.labels,
    children: [],
    comments,
  };
}

/** Fetches GitLab issues (via the glab CLI) and maps them to Vanguard tasks. */
export class GitLabTaskFetcher implements TaskFetcher {
  constructor(
    private readonly project: string,
    private readonly glab: GlabRunner = defaultGlabRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const iid = issueIID(id);
    const issueOut = await this.glab(['issue', 'view', iid, '--project', this.project, '--output', 'json']);
    const issue = JSON.parse(issueOut) as GitLabIssue;
    // notes fetched separately — glab issue view does not include them
    const notesOut = await this.glab(['api', `projects/${encodeProject(this.project)}/issues/${iid}/notes`]);
    const notes = JSON.parse(notesOut) as GitLabNote[];
    return toGitLabTask(this.project, issue, notes);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const args = [
      'issue', 'list',
      '--project', this.project,
      '--output', 'json',
      '--state', filter?.state ?? 'opened',
    ];
    for (const label of filter?.labels ?? []) args.push('--label', label);
    const out = await this.glab(args);
    // comments are not fetched on bulk list() — avoids N+1; only fetch() returns them
    return (JSON.parse(out) as GitLabIssue[]).map((issue) => toGitLabTask(this.project, issue));
  }
}

/** Post a note on a GitLab issue. */
export async function commentGitlabIssue(
  project: string,
  issueRef: string,
  body: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await glab(['issue', 'note', 'create', issueIID(issueRef), '--project', project, '-m', body]);
}

/** Comment an MR link back onto the source GitLab issue (closes the loop). */
export async function linkMergeRequest(
  project: string,
  issueRef: string,
  mrUrl: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await commentGitlabIssue(project, issueRef, `Vanguard opened an MR for review: ${mrUrl}`, glab);
}

/** Add/remove labels on a GitLab issue (used to claim/advance it in the watch loop). */
export async function editGitlabLabels(
  project: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[] },
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  const args = ['issue', 'update', issueIID(issueRef), '--project', project];
  for (const label of labels.add ?? []) args.push('--label', label);
  for (const label of labels.remove ?? []) args.push('--unlabel', label);
  if (args.length > 4) await glab(args);
}
```

- [ ] **Step 4: Add tests for `GitLabTaskFetcher`, `commentGitlabIssue`, `editGitlabLabels`**

Append to `src/tasks/gitlab.test.ts`:

```typescript
import { GitLabTaskFetcher, commentGitlabIssue, editGitlabLabels } from './gitlab.js';

describe('GitLabTaskFetcher', () => {
  const fakeIssue = JSON.stringify({
    iid: 42,
    title: 'Fix bug',
    description: 'Details',
    labels: ['backend'],
  });
  const fakeNotes = JSON.stringify([
    { id: 1, body: 'A comment', author: { username: 'alice' }, system: false },
    { id: 2, body: 'closed', author: { username: 'gitlab' }, system: true },
  ]);

  it('fetch returns task with comments, filters system notes', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      if (args.includes('view')) return fakeIssue;
      return fakeNotes;
    };
    const fetcher = new GitLabTaskFetcher('owner/project', glab);
    const task = await fetcher.fetch('owner/project#42');
    expect(task.id).toBe('owner/project#42');
    expect(task.title).toBe('Fix bug');
    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]!.author).toBe('alice');
    expect(calls[0]).toContain('42');
  });

  it('list returns tasks without comments', async () => {
    const glab = async () => JSON.stringify([{ iid: 1, title: 'T', description: null, labels: [] }]);
    const fetcher = new GitLabTaskFetcher('owner/project', glab);
    const tasks = await fetcher.list({ labels: ['vanguard'] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.comments).toHaveLength(0);
  });

  it('list passes label filters', async () => {
    const args: string[][] = [];
    const glab = async (a: string[]) => { args.push(a); return '[]'; };
    const fetcher = new GitLabTaskFetcher('g/p', glab);
    await fetcher.list({ labels: ['a', 'b'] });
    const listArgs = args[0]!;
    expect(listArgs.filter((a) => a === '--label')).toHaveLength(2);
  });
});

describe('commentGitlabIssue', () => {
  it('calls glab issue note create with correct args', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => { calls.push(args); return ''; };
    await commentGitlabIssue('g/p', 'g/p#5', 'hello', glab);
    expect(calls[0]).toEqual(['issue', 'note', 'create', '5', '--project', 'g/p', '-m', 'hello']);
  });
});

describe('editGitlabLabels', () => {
  it('adds and removes labels', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => { calls.push(args); return ''; };
    await editGitlabLabels('g/p', 'g/p#3', { add: ['foo'], remove: ['bar'] }, glab);
    expect(calls[0]).toContain('--label');
    expect(calls[0]).toContain('foo');
    expect(calls[0]).toContain('--unlabel');
    expect(calls[0]).toContain('bar');
  });

  it('skips call when no labels to change', async () => {
    const calls: string[][] = [];
    const glab = async (args: string[]) => { calls.push(args); return ''; };
    await editGitlabLabels('g/p', 'g/p#3', {}, glab);
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run tests**

```bash
pnpm test src/tasks/gitlab.test.ts
```
Expected: all pass.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/tasks/gitlab.ts src/tasks/gitlab.test.ts
git commit -m "feat(gitlab): GitLabTaskFetcher and issue helpers"
```

---

### Task 3: `src/runners/gitlab.ts` — GitLab issue runner

**Files:**
- Create: `src/runners/gitlab.ts`
- Create: `src/runners/gitlab.test.ts`

**Interfaces:**
- Consumes:
  - `GitLabTaskFetcher`, `linkMergeRequest` from `../tasks/gitlab.js`
  - `publishForReview` from `../pipeline/pipeline.js` — pass `cli: 'glab'`
  - `runGithubIssue` pattern from `./github.ts` — copy the full flow but adapt imports
  - `RunGithubIssueDeps` from `./github.ts` as structural reference (produce parallel `RunGitlabIssueDeps`)
- Produces:
  - `RunGitlabIssueDeps` — same shape as `RunGithubIssueDeps` but no `forkN` (GitLab runner is intentionally minimal: fork-and-select can be added later)
  - `RunGitlabIssueResult = { task: Task; prUrl?: string }`
  - `runGitlabIssue(issueRef: string, deps: RunGitlabIssueDeps): Promise<RunGitlabIssueResult>`
  - `gitlabDepsFromEnv(repoPath, project?, provider?, reviewProvider?): Promise<RunGitlabIssueDeps>`

- [ ] **Step 1: Write failing test for `runGitlabIssue`**

Create `src/runners/gitlab.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runGitlabIssue } from './gitlab.js';
import type { RunGitlabIssueDeps } from './gitlab.js';

describe('runGitlabIssue', () => {
  it('returns no prUrl when agent produces no changes', async () => {
    // Unit test is minimal — the full flow requires Docker. Just verify the dep contract.
    // This test is intentionally thin; integration coverage lives in E2E runs.
    expect(runGitlabIssue).toBeDefined();
    expect(typeof runGitlabIssue).toBe('function');
  });
});
```

- [ ] **Step 2: Run to confirm the import fails**

```bash
pnpm test src/runners/gitlab.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/runners/gitlab.ts`**

Copy `src/runners/github.ts` as the base and make these targeted changes:

1. Replace all `GitHub`/`github`/`gh` references with `GitLab`/`gitlab`/`glab` where appropriate.
2. Change the `TaskFetcher` instantiation: `new GitLabTaskFetcher(deps.project)` instead of `new GitHubTaskFetcher(deps.repoSlug)`.
3. Change `linkPullRequest` → `linkMergeRequest`.
4. Change `publishForReview(ctx, { ..., })` → add `cli: 'glab'` to the options.
5. Remove `forkN` and `addPrFailureLabel` (not in scope for initial GitLab support).
6. Change `taskId` prefix: `gl-` instead of `gh-`.
7. The `deps.project` field replaces `deps.repoSlug` as the GitLab project identifier (`group/project`).

Full file:

```typescript
import { execa } from 'execa';
import { GitLabTaskFetcher, linkMergeRequest } from '../tasks/gitlab.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, implementReviewSimplifyStages, withStageProvider, withStageModel, withStageModelExcept, sandboxComplete, commitStage, publishForReview, withStageFallback } from '../pipeline/pipeline.js';
import { agentAuthFromEnv, authSecrets } from '../agents/auth.js';
import { persistStageOutcomes, persistVerification, persistVisualProof } from '../core/run-record.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { resolveVerifyCommand, runVerification, proofBlock } from '../pipeline/verify.js';
import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, ProviderName } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';

/** Everything needed to run a single GitLab issue end to end. */
export interface RunGitlabIssueDeps extends ProviderChoice {
  auth?: AgentAuth;
  repoPath: string;
  /** GitLab project path, e.g. `group/project`. */
  project: string;
  proxyUrl?: string;
  network?: string;
  llmProxy?: LlmProxyDep;
  reuse?: boolean;
  providerModel?: string;
  reviewModel?: string;
  noSimplify?: boolean;
  verifyCmd?: string;
  visualProofCmd?: string;
}

export interface RunGitlabIssueResult {
  task: Task;
  prUrl?: string;
}

/**
 * Run one GitLab issue end to end: fetch via `glab`, run the canonical implement/review/simplify
 * pipeline, open a draft MR, and comment the MR link back onto the issue.
 */
export async function runGitlabIssue(issueRef: string, deps: RunGitlabIssueDeps): Promise<RunGitlabIssueResult> {
  const task = await new GitLabTaskFetcher(deps.project).fetch(issueRef);

  const agents = selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });

  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies.openai);
    const sandbox = new DockerSandboxProvider({
      image: 'vanguard-sandbox:latest',
      secrets: {
        ...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth ? authSecrets(deps.auth) : {}),
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(deps.network !== undefined ? { network: deps.network } : {}),
    });

    const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath);
    const ctx = await prepareContext({
      taskId: `gl-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
      localRepoPath: deps.repoPath,
      sandbox,
      agentName: agents.agent.name,
      ...(agents.reviewAgent !== undefined ? { reviewAgentName: agents.reviewAgent.name } : {}),
      ...(deps.reuse !== undefined ? { reuse: deps.reuse } : {}),
    });
    try {
      const allStages = implementReviewSimplifyStages();
      const base = deps.noSimplify === true ? allStages.filter((s) => s.name !== 'simplifier') : allStages;
      let pipeline = agents.reviewAgent !== undefined ? withStageProvider(base, agents.reviewAgent) : base;
      if (deps.providerModel !== undefined) {
        const crossProviderReview = deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
        pipeline = crossProviderReview
          ? withStageModelExcept(pipeline, deps.providerModel, 'reviewer')
          : withStageModel(pipeline, deps.providerModel);
      }
      if (deps.reviewModel !== undefined) pipeline = withStageModel(pipeline, deps.reviewModel, 'reviewer');
      if (agents.reviewAgent !== undefined) {
        pipeline = withStageFallback(pipeline, {
          provider: agents.agent,
          ...(deps.providerModel !== undefined ? { model: deps.providerModel } : {}),
        });
      }
      const outcomes = await runStages(ctx, pipeline, {
        agent: agents.agent,
        variables: { ...taskToVariables(task), RETROSPECTIVE_MEMORY: retrospectiveMemory },
      });
      console.log(summarizeOutcomes(outcomes));

      const verifyCmd = await resolveVerifyCommand(ctx.worktreePath, deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {});
      const verification = verifyCmd !== undefined ? await runVerification(ctx.sandbox, verifyCmd) : undefined;
      const visualProof = await resolveAndRunVisualProof(
        ctx.sandbox,
        ctx.worktreePath,
        deps.visualProofCmd !== undefined ? { cmd: deps.visualProofCmd } : {},
      );

      const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
      if (!commit.committed) {
        await persistStageOutcomes(deps.repoPath, outcomes);
        if (verification !== undefined) await persistVerification(deps.repoPath, ctx.taskId, verification);
        if (visualProof !== undefined) await persistVisualProof(deps.repoPath, ctx.taskId, visualProof);
        return { task };
      }
      const baseBody = `Automated implementation of ${task.id} by Vanguard.`;
      const body = [
        baseBody,
        verification !== undefined ? proofBlock(verification) : undefined,
        visualProof !== undefined ? visualProofBlock(visualProof) : undefined,
      ].filter((s): s is string => s !== undefined).join('\n\n');
      const mr = await publishForReview(ctx, { title: `${task.title} (${task.id})`, body, draft: true, cli: 'glab' });

      await persistStageOutcomes(deps.repoPath, outcomes);
      if (verification !== undefined) await persistVerification(deps.repoPath, ctx.taskId, verification);
      if (visualProof !== undefined) await persistVisualProof(deps.repoPath, ctx.taskId, visualProof);
      await refreshRetrospectiveMemory(deps.repoPath, ctx.taskId);
      await linkMergeRequest(deps.project, issueRef, mr.prUrl);
      return { task, prUrl: mr.prUrl };
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}

/** Assemble `RunGitlabIssueDeps` from environment + CLI flags (mirrors `githubDepsFromEnv`). */
export async function gitlabDepsFromEnv(
  repoPath: string,
  project: string | undefined,
  provider?: ProviderName,
  reviewProvider?: ProviderName,
): Promise<RunGitlabIssueDeps> {
  let resolvedProject = project;
  if (resolvedProject === undefined) {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const match = stdout.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match?.[1] === undefined) throw new Error('Cannot detect GitLab project from origin remote. Pass --gitlab-project.');
    resolvedProject = match[1];
  }
  return {
    repoPath,
    project: resolvedProject,
    ...(provider !== undefined ? { provider } : {}),
    ...(reviewProvider !== undefined ? { reviewProvider } : {}),
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/runners/gitlab.test.ts
```
Expected: pass.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/runners/gitlab.ts src/runners/gitlab.test.ts
git commit -m "feat(gitlab): runGitlabIssue runner"
```

---

### Task 4: `src/runners/watch.ts` — GitLab watch + spec primitives

**Files:**
- Modify: `src/runners/watch.ts`
- Modify: `src/runners/watch.test.ts`

**Interfaces:**
- Consumes (from this file, already exported):
  - `WatchPrimitives`, `SpecWatchPrimitives`, `WatchGithubOptions` (for structural reference)
  - `triageAgentRun`, `runSpecCore`, `runWatchLoop`, `runLoopV1` (internal helpers — already exist)
  - `GitLabTaskFetcher`, `editGitlabLabels`, `commentGitlabIssue` from `../tasks/gitlab.js`
  - `runGitlabIssue`, `RunGitlabIssueDeps` from `./gitlab.js`
- Produces (new exports):
  ```typescript
  WatchGitlabOptions
  WatchGitlabSpecOptions
  WatchGitlabLoopV1Options
  gitlabWatchPrimitives(opts: WatchGitlabOptions): WatchPrimitives
  gitlabSpecPrimitives(opts: WatchGitlabSpecOptions): SpecWatchPrimitives
  watchGitlab(opts: WatchGitlabOptions, log?): Promise<void>
  watchGitlabLoopV1(opts: WatchGitlabLoopV1Options, log?): Promise<void>
  ```

- [ ] **Step 1: Add failing tests for `gitlabWatchPrimitives`**

In `src/runners/watch.test.ts`, find the `githubIssueWatchPrimitives` tests block. Add after it:

```typescript
import { gitlabWatchPrimitives } from './watch.js';
import type { WatchGitlabOptions } from './watch.js';

describe('gitlabWatchPrimitives', () => {
  function makeGlab(responses: Record<string, string> = {}) {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      const key = args[0] + ':' + args[1];
      return responses[key] ?? '[]';
    };
    return { glab, calls };
  }

  function makeDeps(project = 'g/p'): WatchGitlabOptions {
    return {
      deps: {
        repoPath: '/repo',
        project,
      } as any,
      label: 'vanguard',
      claimedLabel: 'vanguard::running',
      reviewLabel: 'vanguard::review',
    };
  }

  it('listReady filters issues by label', async () => {
    const { glab } = makeGlab({
      'issue:list': JSON.stringify([
        { iid: 1, title: 'T', description: null, labels: ['vanguard'] },
      ]),
    });
    const opts = makeDeps();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    const ready = await primitives.listReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toContain('#1');
  });

  it('claim adds claimedLabel and removes trigger label', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeDeps();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.claim('g/p#1');
    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('vanguard::running');
    expect(updateCall).toContain('vanguard');
  });

  it('review adds reviewLabel', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeDeps();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.review('g/p#1');
    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toContain('vanguard::review');
  });

  it('onFailure posts a comment', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeDeps();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.onFailure('g/p#1', new Error('boom'));
    const noteCall = calls.find((c) => c[0] === 'issue' && c[1] === 'note');
    expect(noteCall).toBeDefined();
    expect(noteCall).toContain('boom');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test src/runners/watch.test.ts -- --reporter=verbose 2>&1 | tail -20
```
Expected: FAIL — `gitlabWatchPrimitives` not exported.

- [ ] **Step 3: Add imports at top of `src/runners/watch.ts`**

After the existing import block, add:

```typescript
import { GitLabTaskFetcher, editGitlabLabels, commentGitlabIssue, defaultGlabRunner } from '../tasks/gitlab.js';
import { runGitlabIssue } from './gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { RunGitlabIssueDeps } from './gitlab.js';
```

- [ ] **Step 4: Add `WatchGitlabOptions` interface and `gitlabWatchPrimitives`**

Append to `src/runners/watch.ts` (after `watchGithubProject` / before end of file):

```typescript
export interface WatchGitlabOptions {
  deps: RunGitlabIssueDeps;
  /** Trigger label: open issues carrying this label are picked for running. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label`.
   * Absent => only `label` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (trigger label removed) so re-polls skip it. Default: 'vanguard::running'. */
  claimedLabel: string;
  /** Label added after an MR opens (claimed label removed by GitLab scoped-label rule). */
  reviewLabel: string;
  /** Loop-v1 agent-pass triage gate (optional). */
  needsInfoLabel?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  /** Injectable runner for tests. Defaults to `defaultGlabRunner`. */
  gl?: GlabRunner;
}

/** GitLab issue primitives: trigger by label, claim/review by swapping scoped labels. */
export function gitlabWatchPrimitives(opts: WatchGitlabOptions): WatchPrimitives {
  const project = opts.deps.project;
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = new GitLabTaskFetcher(project, glab);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  return {
    listReady: async () => (await fetcher.list({ labels: agentLabels })).map((task) => ({ id: task.id })),
    claim: (id) =>
      editGitlabLabels(project, id, { remove: [opts.label], add: [opts.claimedLabel] }, glab),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGitlabIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGitlabIssue(i, opts.deps), {
              comment: (body) => commentGitlabIssue(project, id, body, glab),
              toNeedsInfo: () =>
                editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, glab),
            }),
    review: (id) =>
      // GitLab scoped labels: adding vanguard::review auto-removes vanguard::running
      editGitlabLabels(project, id, { add: [opts.reviewLabel] }, glab),
    onFailure: (id, error) =>
      commentGitlabIssue(project, id, `Vanguard run failed: ${String(error)}`, glab),
  };
}

export interface WatchGitlabSpecOptions {
  deps: RunSpecGeneratorDeps;
  project: string;
  specLabel: string;
  ownerLabel?: string;
  /** Label added on claim (spec label removed). Default: 'vanguard::speccing'. */
  claimedLabel: string;
  agentLabel: string;
  needsInfoLabel: string;
  gl?: GlabRunner;
  generateSpec?: GenerateSpec;
}

/** GitLab SPEC primitives: triage each issue, generate+post a tech spec, swap to agent label. */
export function gitlabSpecPrimitives(opts: WatchGitlabSpecOptions): SpecWatchPrimitives {
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels =
    opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () =>
      (await fetcher.list({ labels: specLabels })).map((task) => ({ id: task.id })),
    claim: (id) =>
      editGitlabLabels(opts.project, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, glab),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGitlabIssue(opts.project, id, body, glab),
        advance: () =>
          editGitlabLabels(
            opts.project,
            id,
            { remove: [opts.claimedLabel], add: [opts.agentLabel] },
            glab,
          ),
        toNeedsInfo: () =>
          editGitlabLabels(
            opts.project,
            id,
            { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] },
            glab,
          ),
      });
    },
    onFailure: async (id, error) => {
      await commentGitlabIssue(opts.project, id, `Vanguard spec failed: ${String(error)}`, glab);
      // Restore spec label so next poll retries
      await editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, glab);
    },
  };
}

export interface WatchGitlabLoopV1Options {
  spec: WatchGitlabSpecOptions;
  agent: WatchGitlabOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Poll GitLab Issues and run each newly-ready (labeled) issue. */
export async function watchGitlab(
  opts: WatchGitlabOptions,
  log: (msg: string) => void = console.log,
): Promise<void> {
  await runWatchLoop(gitlabWatchPrimitives(opts), opts, log);
}

/** Loop v1 over GitLab Issues: each poll runs the spec pass then the agent pass. */
export async function watchGitlabLoopV1(
  opts: WatchGitlabLoopV1Options,
  log: (msg: string) => void = console.log,
): Promise<void> {
  await runLoopV1(gitlabSpecPrimitives(opts.spec), gitlabWatchPrimitives(opts.agent), opts, log);
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test src/runners/watch.test.ts
```
Expected: all pass including new gitlab tests.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add src/runners/watch.ts src/runners/watch.test.ts
git commit -m "feat(gitlab): watch + spec primitives for GitLab issues"
```

---

### Task 5: `src/runners/mr-review.ts` — GitLab MR review primitives

**Files:**
- Create: `src/runners/mr-review.ts`
- Create: `src/runners/mr-review.test.ts`

**Interfaces:**
- Consumes: `GlabRunner`, `defaultGlabRunner` from `../tasks/gitlab.js`
- Produces (mirrors `pr-review.ts` with glab):
  - `MergeRequestReviewTarget = { project: string; iid: number }`
  - `MergeRequestForReview extends MergeRequestReviewTarget`
  - `MergeRequestReviewer = (mr: MergeRequestForReview) => Promise<string>`
  - `ReviewMergeRequestDeps`
  - `ReviewMergeRequestResult`
  - `parseMergeRequestRef(ref: string, project?: string): MergeRequestReviewTarget`
  - `fetchMergeRequestForReview(target, glab?): Promise<MergeRequestForReview>`
  - `buildMergeRequestReviewPrompt(mr): string`
  - `mergeRequestReviewMarker(sha: string): string`
  - `hasMergeRequestReviewMarker(body: string, sha: string): boolean`
  - `buildMergeRequestReviewComment(agentText: string, sha?: string): string`
  - `postMergeRequestNote(target, body, glab?): Promise<void>`
  - `reviewMergeRequest(ref, deps): Promise<ReviewMergeRequestResult>`

- [ ] **Step 1: Write failing tests**

Create `src/runners/mr-review.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseMergeRequestRef,
  mergeRequestReviewMarker,
  hasMergeRequestReviewMarker,
  buildMergeRequestReviewComment,
} from './mr-review.js';

describe('parseMergeRequestRef', () => {
  it('parses GitLab MR URL', () => {
    const target = parseMergeRequestRef('https://gitlab.com/owner/project/-/merge_requests/42');
    expect(target.project).toBe('owner/project');
    expect(target.iid).toBe(42);
  });
  it('parses self-hosted URL', () => {
    const target = parseMergeRequestRef('https://gitlab.internal/group/sub/project/-/merge_requests/7');
    expect(target.project).toBe('group/sub/project');
    expect(target.iid).toBe(7);
  });
  it('parses bare number with project', () => {
    const target = parseMergeRequestRef('5', 'g/p');
    expect(target.project).toBe('g/p');
    expect(target.iid).toBe(5);
  });
  it('throws on bare number without project', () => {
    expect(() => parseMergeRequestRef('5')).toThrow();
  });
});

describe('mergeRequestReviewMarker', () => {
  it('produces hidden HTML comment with sha', () => {
    const marker = mergeRequestReviewMarker('abc123');
    expect(marker).toContain('vanguard-mr-review');
    expect(marker).toContain('abc123');
  });
});

describe('hasMergeRequestReviewMarker', () => {
  it('detects matching marker', () => {
    const body = 'some text\n<!-- vanguard-mr-review: abc123 -->\nmore';
    expect(hasMergeRequestReviewMarker(body, 'abc123')).toBe(true);
  });
  it('returns false for different sha', () => {
    const body = '<!-- vanguard-mr-review: abc123 -->';
    expect(hasMergeRequestReviewMarker(body, 'def456')).toBe(false);
  });
});

describe('buildMergeRequestReviewComment', () => {
  it('wraps text in Vanguard Review header', () => {
    const comment = buildMergeRequestReviewComment('No blocking findings.');
    expect(comment).toContain('## Vanguard Review');
    expect(comment).toContain('No blocking findings.');
  });
  it('appends marker when sha provided', () => {
    const comment = buildMergeRequestReviewComment('ok', 'deadbeef');
    expect(comment).toContain('vanguard-mr-review');
    expect(comment).toContain('deadbeef');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test src/runners/mr-review.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/runners/mr-review.ts`**

```typescript
import { defaultGlabRunner, encodeProject } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';

export interface MergeRequestReviewTarget {
  project: string;
  iid: number;
}

export interface MergeRequestForReview extends MergeRequestReviewTarget {
  title: string;
  description: string;
  webUrl: string;
  author: string;
  sourceBranch: string;
  sha: string;
  targetBranch: string;
  diff: string;
}

export type MergeRequestReviewer = (mr: MergeRequestForReview) => Promise<string>;

export interface ReviewMergeRequestDeps {
  project?: string;
  glab?: GlabRunner;
  reviewer: MergeRequestReviewer;
  log?: (line: string) => void;
}

export interface ReviewMergeRequestResult {
  mr: MergeRequestForReview;
  commentBody: string;
}

const MR_URL_RE = /\/([^/].*?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/;
const NUMBER_RE = /^\d+$/;
const MR_REVIEW_MARKER_RE = /^<!--[ \t]*vanguard-mr-review:[ \t]*([a-fA-F0-9]+)[ \t]*-->$/gm;
const PROMISE_RE = /<promise>\s*COMPLETE\s*<\/promise>/gi;

export function parseMergeRequestRef(ref: string, project?: string): MergeRequestReviewTarget {
  const trimmed = ref.trim();
  const url = MR_URL_RE.exec(trimmed);
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return { project: url[1], iid: Number(url[2]) };
  }
  if (NUMBER_RE.test(trimmed)) {
    if (project === undefined) throw new Error(`MR ref "${trimmed}" needs --gitlab-project.`);
    return { project, iid: Number(trimmed) };
  }
  throw new Error(`Unsupported MR ref: ${ref}`);
}

interface GlabMrView {
  iid?: number;
  title?: string;
  description?: string | null;
  web_url?: string;
  author?: { username?: string } | null;
  source_branch?: string;
  sha?: string;
  target_branch?: string;
}

export async function fetchMergeRequestForReview(
  target: MergeRequestReviewTarget,
  glab: GlabRunner = defaultGlabRunner,
): Promise<MergeRequestForReview> {
  const iid = String(target.iid);
  const view = JSON.parse(
    await glab(['mr', 'view', iid, '--project', target.project, '--output', 'json']),
  ) as GlabMrView;
  const diff = await glab(['mr', 'diff', iid, '--project', target.project]);
  return {
    project: target.project,
    iid: view.iid ?? target.iid,
    title: view.title ?? '',
    description: view.description ?? '',
    webUrl: view.web_url ?? `https://gitlab.com/${target.project}/-/merge_requests/${target.iid}`,
    author: view.author?.username ?? '',
    sourceBranch: view.source_branch ?? '',
    sha: view.sha ?? '',
    targetBranch: view.target_branch ?? '',
    diff,
  };
}

export function buildMergeRequestReviewPrompt(mr: MergeRequestForReview): string {
  return [
    '<task_instructions>',
    `MR: ${mr.project}!${mr.iid}`,
    `URL: ${mr.webUrl}`,
    `Title: ${mr.title}`,
    `Author: ${mr.author}`,
    `Base: ${mr.targetBranch}`,
    `Head: ${mr.sourceBranch}`,
    `Head SHA: ${mr.sha}`,
    '',
    'Description:',
    mr.description.trim() === '' ? '(empty)' : mr.description,
    '',
    'Review this merge request diff as an independent reviewer. Focus on correctness, security, tests, regressions, and maintainability.',
    'Report only actionable findings that the author can fix. Include file/function evidence when the diff supports it.',
    'If there are no blocking findings, say exactly: No blocking findings.',
    'Return Markdown only. When done, write <promise>COMPLETE</promise>.',
    '',
    '<diff>',
    mr.diff,
    '</diff>',
    '</task_instructions>',
  ].join('\n');
}

export function mergeRequestReviewMarker(sha: string): string {
  return `<!-- vanguard-mr-review: ${sha} -->`;
}

export function hasMergeRequestReviewMarker(body: string, sha: string): boolean {
  return Array.from(body.matchAll(MR_REVIEW_MARKER_RE)).some((m) => m[1] === sha);
}

export function buildMergeRequestReviewComment(agentText: string, sha?: string): string {
  const body = agentText.replace(PROMISE_RE, '').trim();
  const visible = `## Vanguard Review\n\n${body === '' ? 'No blocking findings.' : body}`;
  return sha === undefined || sha === '' ? visible : `${visible}\n\n${mergeRequestReviewMarker(sha)}`;
}

/** Post a Vanguard review as a note on a GitLab MR. */
export async function postMergeRequestNote(
  target: MergeRequestReviewTarget,
  body: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await glab([
    'mr', 'note', 'create',
    String(target.iid),
    '--project', target.project,
    '-m', body,
  ]);
}

export async function reviewMergeRequest(
  ref: string,
  deps: ReviewMergeRequestDeps,
): Promise<ReviewMergeRequestResult> {
  const glab = deps.glab ?? defaultGlabRunner;
  const target = parseMergeRequestRef(ref, deps.project);
  deps.log?.(`review-mr ${target.project}!${target.iid}: fetch -> diff`);
  const mr = await fetchMergeRequestForReview(target, glab);
  deps.log?.(`review-mr ${target.project}!${target.iid}: agent -> reviewing`);
  const reviewText = await deps.reviewer(mr);
  const commentBody = buildMergeRequestReviewComment(reviewText, mr.sha);
  await postMergeRequestNote(target, commentBody, glab);
  deps.log?.(`review-mr ${target.project}!${target.iid}: posted -> mr note`);
  return { mr, commentBody };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/runners/mr-review.test.ts
```
Expected: all pass.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/runners/mr-review.ts src/runners/mr-review.test.ts
git commit -m "feat(gitlab): MR review primitives (mr-review)"
```

---

### Task 6: `src/runners/mr-watch.ts` — GitLab MR watch loop

**Files:**
- Create: `src/runners/mr-watch.ts`
- Create: `src/runners/mr-watch.test.ts`

**Interfaces:**
- Consumes:
  - `hasMergeRequestReviewMarker`, `MergeRequestForReview`, `MergeRequestReviewTarget` from `./mr-review.js`
  - `GlabRunner`, `defaultGlabRunner`, `encodeProject` from `../tasks/gitlab.js`
  - `fanOut` from `../pipeline/fan-out.js`
- Produces (mirrors `pr-watch.ts`):
  - `MergeRequestWatchItem`
  - `MergeRequestWatchPrimitives`
  - `MergeRequestWatchTick`
  - `WatchMergeRequestsOnceOptions`
  - `WatchMergeRequestsLoopOptions`
  - `GitLabMergeRequestWatchOptions`
  - `gitlabMergeRequestWatchPrimitives(opts): MergeRequestWatchPrimitives`
  - `watchMergeRequestsOnce(primitives, opts?): Promise<MergeRequestWatchTick>`
  - `watchMergeRequests(primitives, opts?): Promise<void>`

- [ ] **Step 1: Write failing tests**

Create `src/runners/mr-watch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { gitlabMergeRequestWatchPrimitives, watchMergeRequestsOnce } from './mr-watch.js';

describe('gitlabMergeRequestWatchPrimitives', () => {
  function makeGlab(mrListJson = '[]', existingNotes = '[]') {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'list') return mrListJson;
      if (args[0] === 'api') return existingNotes;
      return '';
    };
    return { glab, calls };
  }

  it('listReady returns non-draft, non-automation MRs with trigger label', async () => {
    const mrList = JSON.stringify([
      { iid: 1, title: 'T', draft: false, author: { username: 'alice' }, sha: 'abc', labels: ['ready for review'] },
      { iid: 2, title: 'T', draft: true, author: { username: 'alice' }, sha: 'xyz', labels: ['ready for review'] },
    ]);
    const { glab } = makeGlab(mrList);
    const primitives = gitlabMergeRequestWatchPrimitives({
      project: 'g/p',
      label: 'ready for review',
      reviewingLabel: 'vanguard::reviewing',
      reviewedLabel: 'vanguard::reviewed',
      glab,
      reviewOne: async () => {},
    });
    const ready = await primitives.listReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.iid).toBe(1);
  });

  it('claim removes trigger label and adds reviewing label', async () => {
    const { glab, calls } = makeGlab();
    const primitives = gitlabMergeRequestWatchPrimitives({
      project: 'g/p',
      label: 'ready for review',
      reviewingLabel: 'vanguard::reviewing',
      reviewedLabel: 'vanguard::reviewed',
      glab,
      reviewOne: async () => {},
    });
    await primitives.claim({ project: 'g/p', iid: 1, title: 'T', draft: false, author: 'alice', sha: 'abc', labels: [] });
    const updateCall = calls.find((c) => c[0] === 'mr' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('vanguard::reviewing');
  });
});

describe('watchMergeRequestsOnce', () => {
  it('returns empty tick when no MRs ready', async () => {
    const primitives = {
      listReady: async () => [],
      claim: async () => {},
      review: async () => {},
      markReviewed: async () => {},
      onFailure: async () => {},
    };
    const tick = await watchMergeRequestsOnce(primitives);
    expect(tick.reviewed).toHaveLength(0);
    expect(tick.failed).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test src/runners/mr-watch.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/runners/mr-watch.ts`**

Mirror `src/runners/pr-watch.ts` replacing GitHub specifics with GitLab:

```typescript
import { fanOut } from '../pipeline/fan-out.js';
import { hasMergeRequestReviewMarker } from './mr-review.js';
import { defaultGlabRunner, encodeProject } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { MergeRequestReviewTarget } from './mr-review.js';

export interface MergeRequestWatchItem extends MergeRequestReviewTarget {
  title: string;
  draft: boolean;
  author: string;
  sha: string;
  labels: string[];
}

export interface MergeRequestWatchPrimitives {
  listReady: () => Promise<MergeRequestWatchItem[]>;
  claim: (item: MergeRequestWatchItem) => Promise<void>;
  review: (item: MergeRequestWatchItem) => Promise<void>;
  markReviewed: (item: MergeRequestWatchItem) => Promise<void>;
  onFailure: (item: MergeRequestWatchItem, error: unknown) => Promise<void>;
}

export interface MergeRequestWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface WatchMergeRequestsOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface WatchMergeRequestsLoopOptions extends WatchMergeRequestsOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

export interface GitLabMergeRequestWatchOptions {
  project: string;
  label: string;
  reviewingLabel: string;
  reviewedLabel: string;
  /** Only review MRs opened by this GitLab username (optional). */
  author?: string;
  glab?: GlabRunner;
  reviewOne: (item: MergeRequestWatchItem) => Promise<void>;
}

interface GlabMrListItem {
  iid?: number;
  title?: string;
  draft?: boolean;
  author?: { username?: string } | null;
  sha?: string;
  labels?: string[];
}

interface GlabMrNoteItem {
  body?: string | null;
  system?: boolean;
}

function mrId(item: MergeRequestWatchItem): string {
  return `${item.project}!${item.iid}`;
}

function isAutomationAuthor(username: string): boolean {
  const lower = username.toLowerCase();
  return lower.includes('vanguard') || lower.endsWith('[bot]') || lower === 'gitlab-ci-token';
}

function parseMrList(
  out: string,
  project: string,
  triggerLabel: string,
  onlyAuthor?: string,
): MergeRequestWatchItem[] {
  const parsed = JSON.parse(out) as GlabMrListItem[];
  return parsed.flatMap((item) => {
    if (item.iid === undefined) return [];
    const author = item.author?.username ?? '';
    const labels = item.labels ?? [];
    const mr: MergeRequestWatchItem = {
      project,
      iid: item.iid,
      title: item.title ?? '',
      draft: item.draft === true,
      author,
      sha: item.sha ?? '',
      labels,
    };
    if (mr.draft) return [];
    if (isAutomationAuthor(author)) return [];
    if (onlyAuthor !== undefined && author !== onlyAuthor) return [];
    if (!labels.includes(triggerLabel)) return [];
    return [mr];
  });
}

function editMrLabels(
  glab: GlabRunner,
  project: string,
  iid: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['mr', 'update', String(iid), '--project', project];
  for (const label of labels.remove ?? []) args.push('--unlabel', label);
  for (const label of labels.add ?? []) args.push('--label', label);
  return glab(args);
}

async function hasExistingReviewForHead(
  glab: GlabRunner,
  item: MergeRequestWatchItem,
): Promise<boolean> {
  if (item.sha === '') return false;
  try {
    const out = await glab([
      'api',
      `projects/${encodeProject(item.project)}/merge_requests/${item.iid}/notes`,
    ]);
    const notes = JSON.parse(out) as GlabMrNoteItem[];
    return notes.some(
      (n) => !n.system && n.body !== undefined && n.body !== null && hasMergeRequestReviewMarker(n.body, item.sha),
    );
  } catch {
    return false;
  }
}

/**
 * GitLab-backed MR review watch primitives. Scoped labels (`vanguard::reviewing`,
 * `vanguard::reviewed`) replace each other automatically on the GitLab side.
 */
export function gitlabMergeRequestWatchPrimitives(
  opts: GitLabMergeRequestWatchOptions,
): MergeRequestWatchPrimitives {
  const glab = opts.glab ?? defaultGlabRunner;
  return {
    listReady: async () => {
      const listArgs = [
        'mr', 'list',
        '--project', opts.project,
        '--state', 'opened',
        '--label', opts.label,
        '--output', 'json',
      ];
      if (opts.author !== undefined) listArgs.push('--author', opts.author);
      const candidates = parseMrList(await glab(listArgs), opts.project, opts.label, opts.author);
      const ready = await Promise.all(
        candidates.map(async (item): Promise<MergeRequestWatchItem | undefined> =>
          (await hasExistingReviewForHead(glab, item)) ? undefined : item,
        ),
      );
      return ready.filter((item): item is MergeRequestWatchItem => item !== undefined);
    },
    claim: (item) =>
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.label],
        add: [opts.reviewingLabel],
      }).then(() => {}),
    review: (item) => opts.reviewOne(item),
    markReviewed: (item) =>
      // GitLab scoped labels: adding vanguard::reviewed auto-removes vanguard::reviewing
      editMrLabels(glab, item.project, item.iid, {
        add: [opts.reviewedLabel],
      }).then(() => {}),
    onFailure: (item) =>
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.reviewingLabel],
        add: [opts.label],
      }).then(() => {}),
  };
}

type MrWatchKind = 'reviewed' | 'failed' | 'skipped';

/** Run one MR-watch poll: list, claim, review, and mark each ready MR. */
export async function watchMergeRequestsOnce(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsOnceOptions = {},
): Promise<MergeRequestWatchTick> {
  const phase = opts.phase ?? 'watch-mrs';
  const ready = await primitives.listReady();
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: MrWatchKind }> => {
      const id = mrId(item);
      try {
        await primitives.claim(item);
        opts.log?.(`${phase} ${id}: claim -> reviewing`);
      } catch {
        opts.log?.(`${phase} ${id}: skipped -> already claimed`);
        return { id, kind: 'skipped' };
      }
      try {
        await primitives.review(item);
        await primitives.markReviewed(item);
        opts.log?.(`${phase} ${id}: reviewed -> marked`);
        return { id, kind: 'reviewed' };
      } catch (error) {
        try {
          await primitives.onFailure(item, error);
        } catch (restoreError) {
          const msg = restoreError instanceof Error ? restoreError.message : String(restoreError);
          opts.log?.(`${phase} ${id}: restore failed -> manual label check (${msg})`);
        }
        opts.log?.(`${phase} ${id}: failed -> retry later`);
        return { id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: MrWatchKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { reviewed: ids('reviewed'), failed: ids('failed'), skipped: ids('skipped') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Poll GitLab MRs until stopped, running the MR review loop for each ready MR. */
export async function watchMergeRequests(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchMergeRequestsOnce(primitives, opts);
    opts.log?.(
      `watch-mrs: ${tick.reviewed.length} reviewed, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`,
    );
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/runners/mr-watch.test.ts
```
Expected: all pass.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/runners/mr-watch.ts src/runners/mr-watch.test.ts
git commit -m "feat(gitlab): MR watch loop (mr-watch)"
```

---

### Task 7: `src/cli/args.ts` — GitLab CLI arguments

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli/args.test.ts`

**Interfaces:**
- Consumes: existing `Command` union and `WatchSource` type (line 5)
- Produces (new in the `Command` union):
  - `{ kind: 'review-mr'; iid: number; project: string; repoPath: string; egress: boolean; llmProxy?: boolean; provider?: ProviderName; reviewModel?: string }`
  - `{ kind: 'watch-mrs'; project: string; repoPath: string; label: string; reviewingLabel: string; reviewedLabel: string; author?: string; concurrency: number; intervalMs: number; once: boolean; egress: boolean; llmProxy?: boolean; provider?: ProviderName; reviewModel?: string }`
  - `{ kind: 'doctor-mrs'; project: string; repoPath: string; label: string; reviewingLabel: string; reviewedLabel: string; provider?: ProviderName; llmProxy?: boolean }`
  - `WatchSource` extended: `'linear' | 'github' | 'project' | 'gitlab'`
  - Watch/doctor/run commands extended for `source: 'gitlab'` with `project?: string`

Note: In `run`, the `source: 'gitlab'` case uses `id` for the issue ref (same field, new source value).

New CLI flags to add to `parseArgs` options:
- `gitlab`: `{ type: 'string' }` — for `run --gitlab group/project#n`
- `gitlab-project`: `{ type: 'string' }` — for `watch/doctor --gitlab-project group/project`
- `mr`: `{ type: 'string' }` — for `review-mr --mr <iid>`

New default constants:
```typescript
const DEFAULT_GITLAB_MR_REVIEWING_LABEL = 'vanguard::reviewing';
const DEFAULT_GITLAB_MR_REVIEWED_LABEL = 'vanguard::reviewed';
```

- [ ] **Step 1: Write failing tests**

In `src/cli/args.test.ts`, find the `run` and `watch` test blocks and add after them:

```typescript
describe('parseCli gitlab run', () => {
  it('parses --gitlab flag as gitlab source', () => {
    const cmd = parseCli(['run', '--gitlab', 'owner/project#42'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('owner/project#42');
  });
});

describe('parseCli watch gitlab', () => {
  it('parses --source gitlab with --gitlab-project', () => {
    const cmd = parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'owner/project', '--label', 'vanguard'], '/repo');
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect((cmd as any).project).toBe('owner/project');
    expect(cmd.label).toBe('vanguard');
  });
});

describe('parseCli review-mr', () => {
  it('parses review-mr with --mr and --gitlab-project', () => {
    const cmd = parseCli(['review-mr', '--mr', '42', '--gitlab-project', 'owner/project'], '/repo');
    assert(cmd.kind === 'review-mr');
    expect((cmd as any).iid).toBe(42);
    expect((cmd as any).project).toBe('owner/project');
  });
});

describe('parseCli watch-mrs', () => {
  it('parses watch-mrs with required flags', () => {
    const cmd = parseCli(['watch-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'watch-mrs');
    expect((cmd as any).project).toBe('g/p');
    expect((cmd as any).label).toBe('ready for review');
    expect((cmd as any).reviewingLabel).toBe('vanguard::reviewing');
    expect((cmd as any).reviewedLabel).toBe('vanguard::reviewed');
  });
});

describe('parseCli doctor-mrs', () => {
  it('parses doctor-mrs with required flags', () => {
    const cmd = parseCli(['doctor-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'doctor-mrs');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test src/cli/args.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `src/cli/args.ts`**

Make these changes in order:

**3a. Extend `WatchSource` (line 5):**
```typescript
type WatchSource = 'linear' | 'github' | 'project' | 'gitlab';
```

**3b. Add new command kinds to the `Command` union** (after `watch-prs` kind, before `stats`):
```typescript
| {
    kind: 'review-mr';
    iid: number;
    project: string;
    repoPath: string;
    egress: boolean;
    llmProxy?: boolean;
    provider?: ProviderName;
    reviewModel?: string;
  }
| {
    kind: 'watch-mrs';
    project: string;
    repoPath: string;
    label: string;
    reviewingLabel: string;
    reviewedLabel: string;
    author?: string;
    concurrency: number;
    intervalMs: number;
    once: boolean;
    egress: boolean;
    llmProxy?: boolean;
    provider?: ProviderName;
    reviewModel?: string;
  }
| {
    kind: 'doctor-mrs';
    project: string;
    repoPath: string;
    label: string;
    reviewingLabel: string;
    reviewedLabel: string;
    provider?: ProviderName;
    llmProxy?: boolean;
  }
```

**3c. Add `project?: string` to the `watch` and `doctor` command kinds** (for `--source gitlab`):
In the `watch` command kind, add: `/** GitLab project path (e.g. group/project); required when source === 'gitlab'. */ project?: string;`
Do the same for `doctor`.

**3d. Add new default constants** (near the other defaults):
```typescript
const DEFAULT_GITLAB_MR_REVIEWING_LABEL = 'vanguard::reviewing';
const DEFAULT_GITLAB_MR_REVIEWED_LABEL = 'vanguard::reviewed';
```

**3e. Add new flags to `parseArgs` options block:**
```typescript
gitlab: { type: 'string' },
'gitlab-project': { type: 'string' },
mr: { type: 'string' },
```

**3f. In the `run` command parsing block** (around line 359), extend the sources array:
```typescript
if (typeof values.gitlab === 'string') sources.push(['gitlab', values.gitlab]);
```

**3g. After the `watch-prs` block, add `review-mr`, `watch-mrs`, `doctor-mrs` blocks:**
```typescript
if (positionals[0] === 'review-mr') {
  const iidRaw = typeof values.mr === 'string' ? Number(values.mr) : undefined;
  const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
  if (iidRaw === undefined || !Number.isInteger(iidRaw) || project === undefined) return { kind: 'help' };
  return {
    kind: 'review-mr',
    iid: iidRaw,
    project,
    repoPath,
    egress: values.egress === true,
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
  };
}

if (positionals[0] === 'watch-mrs' || positionals[0] === 'doctor-mrs') {
  const commandKind = positionals[0];
  const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
  const label = typeof values.label === 'string' ? values.label : undefined;
  if (project === undefined || label === undefined) return { kind: 'help' };
  const concurrency = Number(values.concurrency);
  const interval = Number(values.interval);
  const shared = {
    project,
    repoPath,
    label,
    reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_GITLAB_MR_REVIEWING_LABEL,
    reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_GITLAB_MR_REVIEWED_LABEL,
    ...(typeof values.author === 'string' ? { author: values.author } : {}),
    ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
  };
  if (commandKind === 'doctor-mrs') return { kind: 'doctor-mrs', ...shared };
  return {
    kind: 'watch-mrs',
    ...shared,
    egress: values.egress === true,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    once: values.once === true,
  };
}
```

**3h. In the `watch`/`doctor` block**, extend the source detection to handle `gitlab`:
```typescript
const source: WatchSource =
  values.source === 'github' || (values.source === undefined && typeof values['github-repo'] === 'string')
    ? 'github'
    : values.source === 'project'
      ? 'project'
      : values.source === 'gitlab'
        ? 'gitlab'
        : 'linear';
```

For `gitlab` source: validate that `--label` is provided (same rule as github). Pass `project: values['gitlab-project']` into `common`.

**3i. Add `project` to `common` in the watch/doctor builder:**
```typescript
...(typeof values['gitlab-project'] === 'string' ? { project: values['gitlab-project'] } : {}),
```

**3j. Update `USAGE` string** to document the new commands and flags. Add:
```
  review-mr options:
    --mr <iid>             GitLab MR IID (integer)
    --gitlab-project <g/p> GitLab project path (required)
    --provider --review-model --egress --llm-proxy --repo  As for review-pr

  watch-mrs options:
    --gitlab-project <g/p>  Required project path
    --label <name>          Required trigger label (e.g. "ready for review")
    --reviewing-label <l>   Label added while reviewing (default: "vanguard::reviewing")
    --reviewed-label <l>    Label added after review (default: "vanguard::reviewed")
    --author <username>     Only review MRs by this GitLab username
    --interval --once --concurrency --provider --review-model --egress --llm-proxy  As for watch-prs

  doctor-mrs options:
    Uses the same flags as watch-mrs, but only runs preflight checks and exits.

  watch options (--source gitlab):
    --source gitlab            GitLab issue watch source
    --gitlab-project <g/p>     Required: GitLab project path (e.g. group/project)
    --label <name>             Trigger label; issues must carry this label
    --claimed-state <label>    Label set on claim (default: "vanguard::running")
    --review-state <label>     Label set after MR opens (default: "vanguard::review")
    Loop v1 (--loop-v1 or spec-label flags) works the same as for --source github.
    GitLab boards are label-based — use --source gitlab --label <column-label> to watch a board column.

  run --gitlab <group/project#iid>    Run a GitLab issue
```

Also update `Env:` section to add: `GITLAB_TOKEN (auth for glab; GITLAB_HOST for self-hosted instances)`

- [ ] **Step 4: Run tests**

```bash
pnpm test src/cli/args.test.ts
```
Expected: all pass.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "feat(gitlab): CLI args for gitlab run/watch/review-mr/watch-mrs"
```

---

### Task 8: `src/cli/preflight.ts` — GitLab preflight checks

**Files:**
- Modify: `src/cli/preflight.ts`
- Modify: `src/cli/preflight.test.ts`

**Interfaces:**
- Consumes: `Command` union now includes `review-mr`, `watch-mrs`, `doctor-mrs` and `source: 'gitlab'`
- Produces:
  - `gitlabAuthOk(run, cwd, env): Promise<PreflightCheck>` — checks `GITLAB_TOKEN` env or `glab auth status`
  - `gitlabLabelsOk(run, cwd, project, required): Promise<PreflightCheck>` — checks labels exist via `glab label list --project <project>`
  - Extended `PreflightCommand` type to include `watch-mrs` and `doctor-mrs` kinds
  - Updated `runPreflight()` to run gitlab auth + label checks for `source === 'gitlab'`, `watch-mrs`, and `doctor-mrs`

- [ ] **Step 1: Write failing tests**

In `src/cli/preflight.test.ts`, add new tests after the github ones:

```typescript
describe('runPreflight gitlab source', () => {
  const baseCmd = {
    kind: 'doctor' as const,
    source: 'gitlab' as const,
    project: 'g/p',
    repoPath: '/repo',
    label: 'vanguard',
  };

  it('checks glab auth when GITLAB_TOKEN is absent', async () => {
    let glabAuthCalled = false;
    const run: PreflightRunner = async (cmd, args) => {
      if (cmd === 'glab' && args[0] === 'auth') { glabAuthCalled = true; return { stdout: 'ok' }; }
      if (cmd === 'git') return { stdout: 'https://gitlab.com/g/p.git' };
      if (cmd === 'docker') return { stdout: '{}' };
      if (cmd === 'glab' && args[0] === 'label') return { stdout: '[]' };
      return { stdout: '' };
    };
    await runPreflight(baseCmd, { env: {}, nodeVersion: '24.0.0', run });
    expect(glabAuthCalled).toBe(true);
  });

  it('skips glab auth check when GITLAB_TOKEN is set', async () => {
    let glabAuthCalled = false;
    const run: PreflightRunner = async (cmd, args) => {
      if (cmd === 'glab' && args[0] === 'auth') { glabAuthCalled = true; return { stdout: '' }; }
      if (cmd === 'git') return { stdout: 'https://gitlab.com/g/p.git' };
      if (cmd === 'docker') return { stdout: '{}' };
      if (cmd === 'glab' && args[0] === 'label') return { stdout: '[]' };
      return { stdout: '' };
    };
    await runPreflight(baseCmd, { env: { GITLAB_TOKEN: 'token', ANTHROPIC_API_KEY: 'key' }, nodeVersion: '24.0.0', run });
    expect(glabAuthCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test src/cli/preflight.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Extend `PreflightCommand` type**

In `src/cli/preflight.ts`, update `PreflightCommand`:

```typescript
type WatchCommand = Extract<Command, { kind: 'watch' }>;
type DoctorCommand = Extract<Command, { kind: 'doctor' }>;
type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;
type WatchMrsCommand = Extract<Command, { kind: 'watch-mrs' }>;
type DoctorMrsCommand = Extract<Command, { kind: 'doctor-mrs' }>;
export type PreflightCommand = WatchCommand | DoctorCommand | DoctorPrsCommand | WatchMrsCommand | DoctorMrsCommand;
```

- [ ] **Step 4: Add `gitlabAuthOk` and `gitlabLabelsOk` functions**

Add after `githubLabelsOk`:

```typescript
async function gitlabAuthOk(run: PreflightRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<PreflightCheck> {
  if (hasEnv(env, 'GITLAB_TOKEN')) return check('gitlab auth', true);
  const status = await runOk(run, cwd, 'glab', ['auth', 'status']);
  return status.ok ? check('gitlab auth', true) : check('gitlab auth', false, 'missing');
}

async function gitlabLabelsOk(run: PreflightRunner, cwd: string, project: string, required: string[]): Promise<PreflightCheck> {
  const labels = await runOk(run, cwd, 'glab', ['label', 'list', '--project', project, '--output', 'json']);
  if (!labels.ok) return check('gitlab labels', false, 'unreadable');
  let parsed: Array<{ name?: string }>;
  try {
    parsed = JSON.parse(labels.stdout) as Array<{ name?: string }>;
  } catch {
    return check('gitlab labels', false, 'unreadable');
  }
  const existing = new Set(parsed.map((l) => l.name).filter((n): n is string => n !== undefined));
  const missing = required.filter((l) => !existing.has(l));
  return missing.length === 0 ? check('gitlab labels', true) : check('gitlab labels', false, `missing ${missing.join(', ')}`);
}
```

- [ ] **Step 5: Add `gitlabLabelsFor` helper**

```typescript
function gitlabLabelsFor(cmd: PreflightCommand): string[] {
  if (cmd.kind === 'doctor-mrs' || cmd.kind === 'watch-mrs') {
    return unique([cmd.label, cmd.reviewingLabel, cmd.reviewedLabel]);
  }
  if (cmd.kind !== 'doctor' && cmd.kind !== 'watch') return [];
  if (cmd.source !== 'gitlab') return [];
  // For loop-v1 on gitlab, routing labels come from the same spec/agent label fields as github.
  if ('specLabel' in cmd && cmd.specLabel !== undefined) {
    return unique([
      cmd.label,
      cmd.specLabel,
      (cmd as any).agentLabel,
      (cmd as any).needsInfoLabel,
      (cmd as any).specClaimedLabel ?? GITLAB_DEFAULT_SPEC_CLAIMED_LABEL,
      cmd.claimedState ?? GITLAB_DEFAULT_CLAIMED_LABEL,
      cmd.reviewState ?? GITLAB_DEFAULT_REVIEW_LABEL,
    ]);
  }
  return unique([cmd.label, cmd.claimedState ?? GITLAB_DEFAULT_CLAIMED_LABEL, cmd.reviewState ?? GITLAB_DEFAULT_REVIEW_LABEL]);
}
```

Add constants at the top of the file:
```typescript
const GITLAB_DEFAULT_CLAIMED_LABEL = 'vanguard::running';
const GITLAB_DEFAULT_REVIEW_LABEL = 'vanguard::review';
const GITLAB_DEFAULT_SPEC_CLAIMED_LABEL = 'vanguard::speccing';
```

- [ ] **Step 6: Update `runPreflight` to handle GitLab sources**

In `runPreflight`, after the existing GitHub blocks (`isGithubBacked`, `source === 'github'`), add:

```typescript
const isGitlabBacked =
  cmd.kind === 'doctor-mrs' ||
  cmd.kind === 'watch-mrs' ||
  ((cmd.kind === 'watch' || cmd.kind === 'doctor') && cmd.source === 'gitlab');

if (isGitlabBacked) {
  checks.push(await gitlabAuthOk(run, cmd.repoPath, env));
  const project =
    'project' in cmd && typeof cmd.project === 'string' ? cmd.project : undefined;
  if (project === undefined) {
    checks.push(check('gitlab labels', false, 'project unknown'));
  } else {
    checks.push(await gitlabLabelsOk(run, cmd.repoPath, project, gitlabLabelsFor(cmd)));
  }
}
```

- [ ] **Step 7: Run tests**

```bash
pnpm test src/cli/preflight.test.ts
```
Expected: all pass.

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm typecheck
git add src/cli/preflight.ts src/cli/preflight.test.ts
git commit -m "feat(gitlab): preflight checks for gitlab source and watch-mrs"
```

---

### Task 9: CLI dispatch commands — `review-mr`, `watch-mrs`, `doctor-mrs`

**Files:**
- Create: `src/cli/review-mr.ts`
- Create: `src/cli/watch-mrs.ts`
- Create: `src/cli/doctor-mrs.ts`

No new test files — these are thin dispatch layers. They are tested via integration only.

**Interfaces:**
- Consumes:
  - `reviewMergeRequest`, `MergeRequestForReview`, `MergeRequestReviewer`, `ReviewMergeRequestDeps`, `ReviewMergeRequestResult` from `../runners/mr-review.js`
  - `gitlabMergeRequestWatchPrimitives`, `watchMergeRequests`, `MergeRequestWatchPrimitives`, `WatchMergeRequestsLoopOptions` from `../runners/mr-watch.js`
  - `runPreflight`, `formatPreflightReport` from `./preflight.js`
  - Command types from `./args.js`
  - Sandbox/agent infrastructure (same as `review-pr.ts`)
- Produces:
  - `reviewMrCommand(cmd, deps?): Promise<void>` in `review-mr.ts`
  - `watchMrsCommand(cmd, deps?): Promise<void>` in `watch-mrs.ts`
  - `doctorMrsCommand(cmd): Promise<void>` in `doctor-mrs.ts`

- [ ] **Step 1: Create `src/cli/review-mr.ts`**

Copy `src/cli/review-pr.ts` as base, substituting:
- `ReviewPr` → `ReviewMr`
- `reviewPullRequest` → `reviewMergeRequest`
- `review-pr` → `review-mr`
- `pr.repoSlug#pr.number` → `mr.project!mr.iid`
- Use `buildMergeRequestReviewPrompt` from `../runners/mr-review.js`
- `prRef` → ref string built from `cmd.iid` (not a string ref, just a number + project)

Key difference: `review-mr` has `iid: number` and `project: string` directly on the command (no ref parsing needed at the CLI level). Pass `String(cmd.iid)` as the ref to `reviewMergeRequest` (which accepts a bare number string when `project` is provided via deps).

```typescript
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv, authSecrets } from '../agents/auth.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, runAgent, disposeContext } from '../core/vanguard.js';
import { adversarySystemPrompt } from '../pipeline/pipeline.js';
import { buildMergeRequestReviewPrompt, reviewMergeRequest } from '../runners/mr-review.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { MergeRequestForReview, MergeRequestReviewer, ReviewMergeRequestDeps, ReviewMergeRequestResult } from '../runners/mr-review.js';
import type { Command } from './args.js';

type ReviewMrCommand = Extract<Command, { kind: 'review-mr' }>;
type ReviewMergeRequestRunner = (ref: string, deps: ReviewMergeRequestDeps) => Promise<ReviewMergeRequestResult>;

export interface ReviewMrCommandDeps {
  reviewer?: MergeRequestReviewer;
  reviewMergeRequest?: ReviewMergeRequestRunner;
  log?: (line: string) => void;
}

export async function reviewMrCommand(cmd: ReviewMrCommand, deps: ReviewMrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReview = deps.reviewMergeRequest ?? reviewMergeRequest;
  if (deps.reviewer !== undefined) {
    const result = await runReview(String(cmd.iid), { reviewer: deps.reviewer, project: cmd.project, log });
    log(`review-mr ${result.mr.project}!${result.mr.iid}: done`);
    return;
  }
  const auth = agentAuthFromEnv(cmd.provider !== undefined ? { provider: cmd.provider } : {});
  const sandboxContext = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });
  try {
    const reviewer: MergeRequestReviewer = (mr) => runDefaultMrReviewer(mr, cmd, auth, sandboxContext);
    const result = await runReview(String(cmd.iid), { reviewer, project: cmd.project, log });
    log(`review-mr ${result.mr.project}!${result.mr.iid}: done`);
  } finally {
    await sandboxContext.destroy();
  }
}

async function runDefaultMrReviewer(
  mr: MergeRequestForReview,
  cmd: ReviewMrCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
): Promise<string> {
  const agents = selectAgents(cmd, process.env, { proxyMode: sandboxContext.llmProxy !== undefined });
  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(sandboxContext.proxyUrl, sandboxContext.llmProxy, providerProxies.openai);
    const sandbox = new DockerSandboxProvider({
      image: 'vanguard-sandbox:latest',
      secrets: {
        ...(sandboxContext.llmProxy === undefined && auth !== undefined && agents.injectAnthropicAuth ? authSecrets(auth) : {}),
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
    });
    const taskId = `mr-review-${mr.project.replace(/[^a-zA-Z0-9]/g, '-')}-${mr.iid}`;
    const ctx = await prepareContext({ taskId, localRepoPath: cmd.repoPath, sandbox, agentName: agents.agent.name });
    try {
      const result = await runAgent(ctx, {
        stageName: 'mr-review',
        agent: agents.agent,
        promptTemplate: buildMergeRequestReviewPrompt(mr),
        systemPrompt: adversarySystemPrompt(),
        effort: 'high',
        maxTurns: 8,
        copyBack: false,
        ...(cmd.reviewModel !== undefined ? { model: cmd.reviewModel } : {}),
      });
      return result.finalText;
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
```

- [ ] **Step 2: Create `src/cli/watch-mrs.ts`**

Mirror `src/cli/watch-prs.ts` substituting MR types:

```typescript
import { gitlabMergeRequestWatchPrimitives, watchMergeRequests } from '../runners/mr-watch.js';
import { reviewMrCommand } from './review-mr.js';
import type { Command } from './args.js';
import type { MergeRequestWatchPrimitives, WatchMergeRequestsLoopOptions } from '../runners/mr-watch.js';

type WatchMrsCommand = Extract<Command, { kind: 'watch-mrs' }>;
type ReviewMrCommand = Extract<Command, { kind: 'review-mr' }>;

export type ReviewMrCommandRunner = (cmd: ReviewMrCommand) => Promise<void>;
export type WatchMergeRequestsRunner = (
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions,
) => Promise<void>;

export interface WatchMrsCommandDeps {
  reviewMr?: ReviewMrCommandRunner;
  watchMergeRequests?: WatchMergeRequestsRunner;
  log?: (line: string) => void;
}

export async function watchMrsCommand(cmd: WatchMrsCommand, deps: WatchMrsCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReviewMr = deps.reviewMr ?? ((reviewCmd: ReviewMrCommand) => reviewMrCommand(reviewCmd));
  const runWatchMrs = deps.watchMergeRequests ?? watchMergeRequests;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const primitives = gitlabMergeRequestWatchPrimitives({
    project: cmd.project,
    label: cmd.label,
    reviewingLabel: cmd.reviewingLabel,
    reviewedLabel: cmd.reviewedLabel,
    ...(cmd.author !== undefined ? { author: cmd.author } : {}),
    reviewOne: (item) =>
      runReviewMr({
        kind: 'review-mr',
        iid: item.iid,
        project: item.project,
        repoPath: cmd.repoPath,
        egress: cmd.egress,
        ...(cmd.llmProxy === true ? { llmProxy: true } : {}),
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
      }),
  });
  log(`watch-mrs[gitlab]: polling every ${cmd.intervalMs / 1000}s for MRs labeled "${cmd.label}". Ctrl-C to stop.`);
  try {
    await runWatchMrs(primitives, {
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal: controller.signal,
      log,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
```

- [ ] **Step 3: Create `src/cli/doctor-mrs.ts`**

Mirror `src/cli/doctor-prs.ts`:

```typescript
import { runPreflight, formatPreflightReport } from './preflight.js';
import type { Command } from './args.js';

type DoctorMrsCommand = Extract<Command, { kind: 'doctor-mrs' }>;

export async function doctorMrsCommand(cmd: DoctorMrsCommand): Promise<void> {
  const report = await runPreflight(cmd);
  for (const line of formatPreflightReport(report)) console.log(line);
  if (!report.ok) throw new Error('preflight failed');
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/review-mr.ts src/cli/watch-mrs.ts src/cli/doctor-mrs.ts
git commit -m "feat(gitlab): review-mr, watch-mrs, doctor-mrs CLI commands"
```

---

### Task 10: Wire everything into dispatch (`run.ts`, `watch.ts`, `index.ts`)

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/cli/watch.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes all new functions from previous tasks
- Produces: complete end-to-end dispatch — `vanguard run --gitlab`, `vanguard watch --source gitlab`, `vanguard review-mr`, `vanguard watch-mrs`, `vanguard doctor-mrs` all route correctly

- [ ] **Step 1: Update `src/cli/run.ts`**

Add import:
```typescript
import { runGitlabIssue, gitlabDepsFromEnv } from '../runners/gitlab.js';
```

In `runCommand`, extend the dispatch (after the `project` branch, before the `runGithub` else):
```typescript
} else if (cmd.source === 'gitlab') {
  await runGitlab(cmd, ctx.proxyUrl, ctx.network, ctx.llmProxy);
```

Add the `runGitlab` function:
```typescript
async function runGitlab(
  cmd: RunCommand,
  proxyUrl: string | undefined,
  network: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): Promise<void> {
  if (cmd.parent) throw new Error('--parent is not supported with --gitlab.');
  const deps = await gitlabDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd.provider, cmd.reviewProvider);
  if (proxyUrl !== undefined) deps.proxyUrl = proxyUrl;
  if (network !== undefined) deps.network = network;
  if (llmProxy !== undefined) deps.llmProxy = llmProxy;
  if (cmd.reuse === true) deps.reuse = true;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;
  if (cmd.visualProofCmd !== undefined) deps.visualProofCmd = cmd.visualProofCmd;
  const result = await runGitlabIssue(cmd.id, deps);
  report(result.task.id, result.prUrl);
}
```

Note: `gitlabDepsFromEnv` uses `cmd.repoSlug` to hold the `--gitlab-project` value — check the args.ts changes; if args.ts puts the gitlab project in `cmd.repoSlug`, use that. If it's a separate `cmd.project` field, use that. The `run` command currently has `repoSlug?: string` for github-repo. For gitlab, we need `project?: string` added to the `run` command kind in args.ts (add this if not already done in Task 7).

> **Note for implementer:** In Task 7 (args.ts), the `run` command kind needs `project?: string` added for `--gitlab-project`. If you find `repoSlug` is reused, adapt accordingly and note the decision.

- [ ] **Step 2: Update `src/cli/watch.ts`**

Add imports:
```typescript
import { watchGitlab, watchGitlabLoopV1, gitlabWatchPrimitives, gitlabSpecPrimitives } from '../runners/watch.js';
import { GitLabTaskFetcher } from '../tasks/gitlab.js';
import { GITLAB_CLAIMED_LABEL, GITLAB_REVIEW_LABEL, GITLAB_SPEC_CLAIMED_LABEL } from '../gitlab-labels.js';
import { gitlabDepsFromEnv } from '../runners/gitlab.js';
```

In `watchCommand`, extend the source dispatch (add a branch for `gitlab`):
```typescript
} else if (cmd.source === 'gitlab') {
  await watchGitlabSource(cmd, auth, ctx, controller.signal);
}
```

Add `watchGitlabSource` function (mirror `watchGithubSource`):
```typescript
async function watchGitlabSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const project = (cmd as any).project as string | undefined;
  const deps = await gitlabDepsFromEnv(cmd.repoPath, project, cmd.provider, cmd.reviewProvider);
  if (auth !== undefined) deps.auth = auth;
  if (ctx.proxyUrl !== undefined && ctx.network !== undefined) {
    deps.proxyUrl = ctx.proxyUrl;
    deps.network = ctx.network;
  }
  if (ctx.llmProxy !== undefined) deps.llmProxy = ctx.llmProxy;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;

  // Loop v1: activated when --spec-label is supplied.
  if (cmd.specLabel !== undefined) {
    if (cmd.agentLabel === undefined || cmd.needsInfoLabel === undefined) {
      throw new Error('--agent-label and --needs-info-label are required with --spec-label for gitlab loop-v1');
    }
    const specDeps = {
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new GitLabTaskFetcher(deps.project),
      ...(ctx.proxyUrl !== undefined && ctx.network !== undefined ? { proxyUrl: ctx.proxyUrl, network: ctx.network } : {}),
      ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
    };
    await watchGitlabLoopV1({
      spec: {
        deps: specDeps,
        project: deps.project,
        specLabel: cmd.specLabel,
        claimedLabel: cmd.specClaimedLabel ?? GITLAB_SPEC_CLAIMED_LABEL,
        agentLabel: cmd.agentLabel,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      agent: {
        deps,
        label: cmd.agentLabel,
        claimedLabel: cmd.claimedState ?? GITLAB_CLAIMED_LABEL,
        reviewLabel: cmd.reviewState ?? GITLAB_REVIEW_LABEL,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal,
    });
    return;
  }

  if (cmd.label === undefined) throw new Error('--label is required for gitlab watch source');
  await watchGitlab({
    deps,
    label: cmd.label,
    claimedLabel: cmd.claimedState ?? GITLAB_CLAIMED_LABEL,
    reviewLabel: cmd.reviewState ?? GITLAB_REVIEW_LABEL,
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    signal,
  });
}
```

- [ ] **Step 3: Update `src/cli/index.ts`**

Add imports and dispatch branches:

```typescript
import { reviewMrCommand } from './review-mr.js';
import { watchMrsCommand } from './watch-mrs.js';
import { doctorMrsCommand } from './doctor-mrs.js';
```

In `main()`, add new branches (after the `watch-prs` branch):
```typescript
if (command.kind === 'review-mr') {
  await reviewMrCommand(command);
  return;
}
if (command.kind === 'watch-mrs') {
  await watchMrsCommand(command);
  return;
}
if (command.kind === 'doctor-mrs') {
  await doctorMrsCommand(command);
  return;
}
```

- [ ] **Step 4: Update `src/index.ts`**

Add exports for all new public symbols:

```typescript
export { GITLAB_CLAIMED_LABEL, GITLAB_REVIEW_LABEL, GITLAB_SPEC_CLAIMED_LABEL, GITLAB_MR_REVIEWING_LABEL, GITLAB_MR_REVIEWED_LABEL } from './gitlab-labels.js';
export { GitLabTaskFetcher, issueIID, encodeProject, defaultGlabRunner, commentGitlabIssue, editGitlabLabels, linkMergeRequest } from './tasks/gitlab.js';
export type { GlabRunner, GitLabIssue, GitLabNote } from './tasks/gitlab.js';
export { runGitlabIssue, gitlabDepsFromEnv } from './runners/gitlab.js';
export type { RunGitlabIssueDeps, RunGitlabIssueResult } from './runners/gitlab.js';
export {
  gitlabWatchPrimitives,
  gitlabSpecPrimitives,
  watchGitlab,
  watchGitlabLoopV1,
} from './runners/watch.js';
export type { WatchGitlabOptions, WatchGitlabSpecOptions, WatchGitlabLoopV1Options } from './runners/watch.js';
export {
  parseMergeRequestRef,
  fetchMergeRequestForReview,
  buildMergeRequestReviewPrompt,
  mergeRequestReviewMarker,
  hasMergeRequestReviewMarker,
  buildMergeRequestReviewComment,
  postMergeRequestNote,
  reviewMergeRequest,
} from './runners/mr-review.js';
export type { MergeRequestReviewTarget, MergeRequestForReview, MergeRequestReviewer, ReviewMergeRequestDeps, ReviewMergeRequestResult } from './runners/mr-review.js';
export {
  gitlabMergeRequestWatchPrimitives,
  watchMergeRequestsOnce,
  watchMergeRequests,
} from './runners/mr-watch.js';
export type { MergeRequestWatchItem, MergeRequestWatchPrimitives, MergeRequestWatchTick, GitLabMergeRequestWatchOptions } from './runners/mr-watch.js';
```

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```
Expected: all tests pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/run.ts src/cli/watch.ts src/cli/index.ts src/index.ts
git commit -m "feat(gitlab): wire gitlab dispatch into run/watch/index + export new symbols"
```
