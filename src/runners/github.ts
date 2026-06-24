import { execa } from 'execa';
import { GitHubTaskFetcher, linkPullRequest } from '../tasks/github.js';
import { GitHubProjectFetcher } from '../tasks/github-project.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { fanOut } from '../pipeline/fan-out.js';
import { runSourcedIssue } from './source-adapter.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, ProviderName } from '../agents/registry.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SourceAdapter } from './source-adapter.js';

/** Everything needed to run a single GitHub issue end to end. */
export interface RunGithubIssueDeps extends ProviderChoice {
  auth?: AgentAuth;
  repoPath: string;
  repoSlug: string;
  /** When set, route the sandbox's egress through this proxy URL (HTTPS_PROXY). */
  proxyUrl?: string;
  /** When set, join the sandbox to this docker network (the hard egress enclave). */
  network?: string;
  /**
   * When set, route Claude through a trusted LLM-proxy sidecar: the real Anthropic credential stays
   * out of the sandbox, which authenticates with the per-run nonce against the proxy host instead.
   */
  llmProxy?: LlmProxyDep;
  /** When true, reuse an existing vanguard/<taskId>-* branch/worktree instead of minting a new run id. */
  reuse?: boolean;
  /** When set (>=2), run the implementer as N variants and keep the best-scored diff (forkAndSelect). */
  forkN?: number;
  /** Model for the implementer/simplifier stages (default: provider's default). */
  providerModel?: string;
  /** Model for the review stage (default: provider's default). */
  reviewModel?: string;
  /** Skip the simplifier stage (lean run: implement -> review only). */
  noSimplify?: boolean;
  /** Verification command for Proof of Work (overrides VANGUARD_VERIFY_CMD and auto-detect). */
  verifyCmd?: string;
  /** Visual proof command for UI artifacts (overrides VANGUARD_VISUAL_PROOF_CMD). Failure never blocks the PR. */
  visualProofCmd?: string;
  /** When true, blocking (high/critical) reviewer findings post as --request-changes to block merge. */
  reviewGate?: boolean;
}

export interface RunGithubIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
}

function githubAdapter(deps: RunGithubIssueDeps): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      const task = await new GitHubTaskFetcher(deps.repoSlug).fetch(issueRef);
      return { task };
    },
    taskId: (task) => `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    async linkPr(issueRef: string, _task: Task, prUrl: string) {
      await linkPullRequest(deps.repoSlug, issueRef, prUrl);
    },
  };
}

/**
 * Run one GitHub issue end to end: fetch via `gh`, run the canonical implement/review/simplify
 * pipeline (the issue title/body go in as variables — no skill needed), open a draft PR, and comment
 * the PR link back onto the issue. GitHub is both the source and the review surface.
 */
export async function runGithubIssue(issueRef: string, deps: RunGithubIssueDeps): Promise<RunGithubIssueResult> {
  return runSourcedIssue(issueRef, deps, githubAdapter(deps));
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
export async function githubDepsFromEnv(
  repoPath: string,
  repoSlug?: string,
  provider?: ProviderName,
  reviewProvider?: ProviderName,
): Promise<RunGithubIssueDeps> {
  const auth = agentAuthFromEnv({
    ...(provider !== undefined ? { provider } : {}),
    ...(reviewProvider !== undefined ? { reviewProvider } : {}),
  });
  const slug = repoSlug ?? process.env.GITHUB_REPO ?? (await detectRepoSlug(repoPath));
  return { ...(auth !== undefined ? { auth } : {}), repoPath, repoSlug: slug };
}

/** Extract the owner/repo slug from the origin remote. */
export async function detectRepoSlug(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd });
  const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match?.[1] === undefined) throw new Error(`Could not detect repo from origin: ${stdout.trim()}`);
  return match[1];
}
