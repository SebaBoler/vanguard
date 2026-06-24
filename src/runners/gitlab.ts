import { execa } from 'execa';
import { GitLabTaskFetcher, linkMergeRequest } from '../tasks/gitlab.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, implementReviewSimplifyStages, withStageProvider, withStageModel, withStageModelExcept, commitStage, publishForReview, withStageFallback } from '../pipeline/pipeline.js';
import { authSecrets } from '../agents/auth.js';
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
      await linkMergeRequest(deps.project, issueRef, mr.prUrl);
      return { task, prUrl: mr.prUrl };
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
