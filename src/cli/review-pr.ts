import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv, authSecrets } from '../agents/auth.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, runAgent, disposeContext } from '../core/vanguard.js';
import { adversarySystemPrompt } from '../pipeline/pipeline.js';
import { buildPullRequestReviewPrompt, PullRequestReviewIncompleteError, reviewPullRequest } from '../runners/pr-review.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { PullRequestForReview, PullRequestReviewAttempt, PullRequestReviewOutcome, PullRequestReviewer, ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';
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
  const toFile = cmd.out !== undefined;

  // --out routes the review to a local file and suppresses the PR comment — a no-trace review for
  // client repos (nothing is posted to the tracker). Default posts the comment, as before.
  const deliver = async (result: ReviewPullRequestResult): Promise<void> => {
    if (cmd.out !== undefined) {
      await mkdir(dirname(cmd.out), { recursive: true });
      await writeFile(cmd.out, result.commentBody, 'utf8');
      log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: written to ${resolve(cmd.out)} (no PR comment)`);
      return;
    }
    log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: done`);
  };

  const runAndDeliver = async (reviewer: PullRequestReviewer): Promise<void> => {
    try {
      await deliver(
        await runReview(cmd.prRef, {
          reviewer,
          log,
          publish: !toFile,
          ...(cmd.repoSlug !== undefined ? { repoSlug: cmd.repoSlug } : {}),
        }),
      );
    } catch (error) {
      // --out callers still get the incomplete notice on disk; the rethrow keeps the exit code truthful.
      if (cmd.out !== undefined && error instanceof PullRequestReviewIncompleteError) {
        await mkdir(dirname(cmd.out), { recursive: true });
        await writeFile(cmd.out, error.commentBody, 'utf8');
        log(`review-pr ${error.pr.repoSlug}#${error.pr.number}: incomplete notice written to ${resolve(cmd.out)} (no PR comment)`);
      }
      throw error;
    }
  };

  if (deps.reviewer !== undefined) {
    await runAndDeliver(deps.reviewer);
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
    await runAndDeliver((pr, opts) => runDefaultReviewer(pr, cmd, auth, sandboxContext, opts));
  } finally {
    await sandboxContext.destroy();
  }
}

async function runDefaultReviewer(
  pr: PullRequestForReview,
  cmd: ReviewPrCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
  opts: PullRequestReviewAttempt,
): Promise<PullRequestReviewOutcome> {
  const agents = selectAgents(cmd, process.env, { proxyMode: sandboxContext.llmProxy !== undefined });

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox. Created
  // before prepareContext so the finally below tears them down even if context provisioning throws.
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
    const taskId = `pr-review-${pr.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${pr.number}`;
    const ctx = await prepareContext({ taskId, localRepoPath: cmd.repoPath, sandbox, agentName: agents.agent.name });
    try {
      const result = await runAgent(ctx, {
        stageName: 'pr-review',
        agent: agents.agent,
        promptTemplate: buildPullRequestReviewPrompt(pr, { retryTriage: opts.isRetry }),
        systemPrompt: adversarySystemPrompt(),
        effort: opts.isRetry ? 'xhigh' : 'high',
        maxTurns: opts.isRetry ? 24 : 16,
        copyBack: false,
        ...(cmd.reviewModel !== undefined ? { model: cmd.reviewModel } : {}),
      });
      return { text: result.finalText, completed: result.completed };
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
