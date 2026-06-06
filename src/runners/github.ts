import { execa } from 'execa';
import { GitHubTaskFetcher, linkPullRequest } from '../tasks/github.js';
import { GitHubProjectFetcher } from '../tasks/github-project.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { ClaudeCodeProvider } from '../agents/claude-code.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, implementReviewSimplifyStages, commitStage, publishForReview } from '../pipeline/pipeline.js';
import { fanOut } from '../pipeline/fan-out.js';
import { authFromEnv, authSecrets } from '../agents/auth.js';
import { persistStageOutcomes } from '../core/run-record.js';
import { egressEnv } from '../sandbox/egress-proxy.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';

/** Everything needed to run a single GitHub issue end to end. */
export interface RunGithubIssueDeps {
  auth: AgentAuth;
  repoPath: string;
  repoSlug: string;
  /** When set, route the sandbox's egress through this proxy URL (HTTPS_PROXY). */
  proxyUrl?: string;
  /** When set, join the sandbox to this docker network (the hard egress enclave). */
  network?: string;
}

export interface RunGithubIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
}

/**
 * Run one GitHub issue end to end: fetch via `gh`, run the canonical implement/review/simplify
 * pipeline (the issue title/body go in as variables — no skill needed), open a draft PR, and comment
 * the PR link back onto the issue. GitHub is both the source and the review surface.
 */
export async function runGithubIssue(issueRef: string, deps: RunGithubIssueDeps): Promise<RunGithubIssueResult> {
  const task = await new GitHubTaskFetcher(deps.repoSlug).fetch(issueRef);

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    secrets: authSecrets(deps.auth),
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    ...(deps.proxyUrl !== undefined ? { env: egressEnv(deps.proxyUrl) } : {}),
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });

  const ctx = await prepareContext({ taskId: `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`, localRepoPath: deps.repoPath, sandbox });
  try {
    const outcomes = await runStages(ctx, implementReviewSimplifyStages(), {
      agent: new ClaudeCodeProvider(),
      variables: taskToVariables(task),
    });
    const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
    if (!commit.committed) {
      await persistStageOutcomes(deps.repoPath, outcomes);
      return { task };
    }
    const pr = await publishForReview(ctx, {
      title: `${task.title} (${task.id})`,
      body: `Automated implementation of ${task.id} by Vanguard.`,
      draft: true,
    });
    await persistStageOutcomes(deps.repoPath, outcomes, pr.prUrl);
    await linkPullRequest(deps.repoSlug, issueRef, pr.prUrl);
    return { task, prUrl: pr.prUrl };
  } finally {
    await disposeContext(ctx);
  }
}

/**
 * Run every issue on a GitHub Projects v2 board (optionally filtered by label) as its own run + PR,
 * concurrently and with failure isolation. The owner defaults to the repo slug's owner.
 */
export async function runGithubProject(
  deps: RunGithubIssueDeps,
  opts: { projectNumber: number; owner?: string; label?: string; concurrency?: number },
): Promise<{ tasks: Task[]; outcomes: FanOutOutcome<Task, RunGithubIssueResult>[] }> {
  const owner = opts.owner ?? (deps.repoSlug.split('/')[0] as string);
  const fetcher = new GitHubProjectFetcher({ owner, projectNumber: opts.projectNumber, repo: deps.repoSlug });
  const tasks = await fetcher.list(opts.label !== undefined ? { labels: [opts.label] } : undefined);
  const outcomes = await fanOut(tasks, (task) => runGithubIssue(task.id, deps), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return { tasks, outcomes };
}

/** Read the run dependencies from the environment (+ flag overrides), resolving the repo slug from origin. */
export async function githubDepsFromEnv(repoPath: string, repoSlug?: string): Promise<RunGithubIssueDeps> {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  const slug = repoSlug ?? process.env.GITHUB_REPO ?? (await detectRepoSlug(repoPath));
  return { auth, repoPath, repoSlug: slug };
}

/** Extract the owner/repo slug from the origin remote. */
export async function detectRepoSlug(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd });
  const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match?.[1] === undefined) throw new Error(`Could not detect repo from origin: ${stdout.trim()}`);
  return match[1];
}
