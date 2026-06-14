import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { authFromEnv, authSecrets } from '../agents/auth.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, runAgent, disposeContext } from '../core/vanguard.js';
import { adversarySystemPrompt } from '../pipeline/pipeline.js';
import { buildPullRequestReviewPrompt, reviewPullRequest } from '../runners/pr-review.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { PullRequestForReview, PullRequestReviewer, ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';
import type { Command } from './args.js';

type ReviewPrCommand = Extract<Command, { kind: 'review-pr' }>;
type ReviewPullRequestRunner = (ref: string, deps: ReviewPullRequestDeps) => Promise<ReviewPullRequestResult>;

export interface ReviewPrCommandDeps {
  reviewer?: PullRequestReviewer;
  reviewPullRequest?: ReviewPullRequestRunner;
  log?: (line: string) => void;
}

/** Review an existing GitHub PR and post a non-blocking GitHub review comment. */
export async function reviewPrCommand(cmd: ReviewPrCommand, deps: ReviewPrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReview = deps.reviewPullRequest ?? reviewPullRequest;
  if (deps.reviewer !== undefined) {
    const result = await runReview(cmd.prRef, {
      reviewer: deps.reviewer,
      log,
      ...(cmd.repoSlug !== undefined ? { repoSlug: cmd.repoSlug } : {}),
    });
    log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: done`);
    return;
  }

  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  const sandboxContext = await startSandboxContext({ egress: cmd.egress, llmProxy: cmd.llmProxy === true, auth });
  try {
    const reviewer: PullRequestReviewer = (pr) => runDefaultReviewer(pr, cmd, auth, sandboxContext);
    const result = await runReview(cmd.prRef, {
      reviewer,
      log,
      ...(cmd.repoSlug !== undefined ? { repoSlug: cmd.repoSlug } : {}),
    });
    log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: done`);
  } finally {
    await sandboxContext.destroy();
  }
}

async function runDefaultReviewer(
  pr: PullRequestForReview,
  cmd: ReviewPrCommand,
  auth: AgentAuth,
  sandboxContext: SandboxContext,
): Promise<string> {
  const agents = selectAgents(cmd);
  const env = llmProxySandboxEnv(sandboxContext.proxyUrl, sandboxContext.llmProxy);
  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    secrets: { ...(sandboxContext.llmProxy === undefined ? authSecrets(auth) : {}), ...agents.secrets },
    ...sandboxResourceLimits(),
    ...(env !== undefined ? { env } : {}),
    ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
  });
  const taskId = `pr-review-${pr.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${pr.number}`;
  const ctx = await prepareContext({ taskId, localRepoPath: cmd.repoPath, sandbox });
  try {
    const result = await runAgent(ctx, {
      stageName: 'pr-review',
      agent: agents.agent,
      promptTemplate: buildPullRequestReviewPrompt(pr),
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
}
