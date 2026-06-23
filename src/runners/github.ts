import { execa } from 'execa';
import { GitHubTaskFetcher, linkPullRequest, addPrFailureLabel } from '../tasks/github.js';
import { GitHubProjectFetcher } from '../tasks/github-project.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, implementReviewSimplifyStages, withStageProvider, withStageModel, withStageModelExcept, sandboxComplete, commitStage, publishForReview } from '../pipeline/pipeline.js';
import { fanOut } from '../pipeline/fan-out.js';
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

  const agents = selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox. Created
  // before prepareContext so the finally below tears them down even if context provisioning throws.
  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies.openai);
    const sandbox = new DockerSandboxProvider({
      image: 'vanguard-sandbox:latest',
      // In llm-proxy mode the real Claude secret stays in the sidecar — the sandbox gets only the nonce.
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
      taskId: `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
      localRepoPath: deps.repoPath,
      sandbox,
      agentName: agents.agent.name,
      ...(agents.reviewAgent !== undefined ? { reviewAgentName: agents.reviewAgent.name } : {}),
      ...(deps.reuse !== undefined ? { reuse: deps.reuse } : {}),
    });
    try {
      const allStages = implementReviewSimplifyStages();
      // --no-simplify: drop the third (cleanup) stage and run implement -> review only.
      const base = deps.noSimplify === true ? allStages.filter((s) => s.name !== 'simplifier') : allStages;
      let pipeline = agents.reviewAgent !== undefined ? withStageProvider(base, agents.reviewAgent) : base;
      if (deps.providerModel !== undefined) {
        // Only a CROSS-provider reviewer is excluded from the implement model (a Codex reviewer rejects an
        // Anthropic model name); a same-provider reviewer keeps it like every other stage. Gating on the
        // mere presence of reviewAgent would wrongly strip the model when --review-provider equals --provider.
        const crossProviderReview = deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
        pipeline = crossProviderReview
          ? withStageModelExcept(pipeline, deps.providerModel, 'reviewer')
          : withStageModel(pipeline, deps.providerModel);
      }
      if (deps.reviewModel !== undefined) pipeline = withStageModel(pipeline, deps.reviewModel, 'reviewer');
      const outcomes = await runStages(ctx, pipeline, {
        agent: agents.agent,
        variables: { ...taskToVariables(task), RETROSPECTIVE_MEMORY: retrospectiveMemory },
        ...(deps.forkN !== undefined ? { fork: { n: deps.forkN, complete: sandboxComplete(ctx, agents.agent) } } : {}),
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
      const pr = await publishForReview(ctx, { title: `${task.title} (${task.id})`, body, draft: true });
      await persistStageOutcomes(deps.repoPath, outcomes, pr.prUrl);
      if (verification !== undefined) await persistVerification(deps.repoPath, ctx.taskId, verification);
      if (visualProof !== undefined) await persistVisualProof(deps.repoPath, ctx.taskId, visualProof);
      if (verification !== undefined && !verification.passed) await addPrFailureLabel(deps.repoPath, pr.prUrl, 'vanguard:verify-failed');
      if (visualProof !== undefined && !visualProof.passed) await addPrFailureLabel(deps.repoPath, pr.prUrl, 'vanguard:visual-proof-failed');
      await linkPullRequest(deps.repoSlug, issueRef, pr.prUrl);
      return { task, prUrl: pr.prUrl };
    } finally {
      await refreshRetrospectiveMemory(deps.repoPath).catch((err: unknown) => {
        console.error('retrospective memory refresh failed (non-fatal):', err);
      });
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
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
