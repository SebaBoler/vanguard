import { LinearCliTaskFetcher, linkLinearIssue } from '../tasks/linear-cli.js';
import { addPrFailureLabel } from '../tasks/github.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, implementReviewSimplifyStages, withStageProvider, withStageModel, withStageModelExcept, sandboxComplete, commitStage, publishForReview, retrospectiveMemoryBlock } from '../pipeline/pipeline.js';
import { fanOut } from '../pipeline/fan-out.js';
import { agentAuthFromEnv, authSecrets } from '../agents/auth.js';
import { persistStageOutcomes, persistVerification, persistVisualProof } from '../core/run-record.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { resolveVerifyCommand, runVerification, proofBlock } from '../pipeline/verify.js';
import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { skillRegistryFromDirectory } from '../context/skill-registry.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { Task, SubTask } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, ProviderName } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';

/** Everything needed to run a single Linear issue end to end. */
export interface RunLinearIssueDeps extends ProviderChoice {
  auth?: AgentAuth;
  linearKey: string;
  repoPath: string;
  skillsDir: string;
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

export interface RunLinearIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
}

/**
 * Run one Linear issue end to end: the agent reads it from inside the sandbox via the injected
 * linear-cli skill, runs the canonical implement/review/simplify pipeline, opens a draft GitHub PR,
 * and comments the PR link back onto the issue. Each call provisions its own sandbox, so callers can
 * fan several out concurrently (see runLinearParent).
 */
export async function runLinearIssue(issueRef: string, deps: RunLinearIssueDeps): Promise<RunLinearIssueResult> {
  const [task, skills] = await Promise.all([
    new LinearCliTaskFetcher().fetch(issueRef),
    skillRegistryFromDirectory(deps.skillsDir),
  ]);

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
        LINEAR_API_KEY: deps.linearKey,
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(deps.network !== undefined ? { network: deps.network } : {}),
    });

    const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath);
    const ctx = await prepareContext(
      { taskId: `linear-${task.id.toLowerCase()}`, localRepoPath: deps.repoPath, sandbox, ...(deps.reuse !== undefined ? { reuse: deps.reuse } : {}) },
      { skills },
    );
    try {
      // --no-simplify: drop the third (cleanup) stage and run implement -> review only.
      const base = deps.noSimplify === true ? stages().filter((s) => s.name !== 'simplifier') : stages();
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
        variables: { ...taskToVariables(task), ISSUE: issueRef, RETROSPECTIVE_MEMORY: retrospectiveMemory },
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
      await linkLinearIssue(task.id, pr.prUrl);
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

/** Fan a Linear parent issue out into one independent run (and PR) per sub-issue. */
export async function runLinearParent(
  parentRef: string,
  deps: RunLinearIssueDeps,
  opts: { concurrency?: number } = {},
): Promise<{ parent: Task; outcomes: FanOutOutcome<SubTask, RunLinearIssueResult>[] }> {
  const parent = await new LinearCliTaskFetcher().fetch(parentRef);
  const outcomes = await fanOut(parent.children, (child) => runLinearIssue(child.id, deps), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return { parent, outcomes };
}

/** Read the run dependencies from the environment, throwing actionable errors when one is missing. */
export function linearDepsFromEnv(provider?: ProviderName): RunLinearIssueDeps {
  const auth = agentAuthFromEnv(provider !== undefined ? { provider } : {});
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR to a directory of skills (e.g. a clone of schpet/linear-cli /skills).');
  }
  return { ...(auth !== undefined ? { auth } : {}), linearKey, skillsDir, repoPath: process.env.REPO_PATH ?? process.cwd() };
}

/**
 * The canonical implement/review/simplify pipeline with only the implementer's prompt swapped, so
 * the agent reads the issue from Linear via the injected linear-cli skill. The review and simplify
 * stages stay canonical (no duplicated prompts, no silently dropped review).
 */
function stages(): PipelineStage[] {
  const base = implementReviewSimplifyStages();
  const implementer = base[0];
  if (implementer === undefined) throw new Error('implementReviewSimplifyStages() returned no stages');
  const readAndImplement = [
    'Use the linear-cli skill to read Linear issue {{ISSUE}} for the full spec:',
    'run `linear issue view {{ISSUE}} --json` (the `linear` CLI is installed and LINEAR_API_KEY is set).',
    '',
    'Implement it in the current repo, keeping the change minimal. If the description is too vague to',
    'write code, add or update NOTES.md summarising the issue instead.',
    '',
    retrospectiveMemoryBlock(),
    '',
    'When done, write <promise>COMPLETE</promise>.',
    '',
    'Title: {{TITLE}}',
  ].join('\n');
  return [{ ...implementer, promptTemplate: readAndImplement }, ...base.slice(1)];
}
