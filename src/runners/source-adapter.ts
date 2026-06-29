import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, assembleReviewPipeline, sandboxComplete, commitStage, publishForReview } from '../pipeline/pipeline.js';
import { buildReviewerAttribution } from '../pipeline/review-publish.js';
import { authSecrets } from '../agents/auth.js';
import { persistStageOutcomes, persistVerification, persistVisualProof } from '../core/run-record.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { resolveVerifyCommand, runVerification, proofBlock } from '../pipeline/verify.js';
import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { reviewRequestBody } from './review-body.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { PipelineStage, StageOutcome } from '../pipeline/pipeline.js';
import type { SkillRegistry } from '../context/skill-registry.js';

/** Agent-pipeline options shared by the `run` and `watch` commands, threaded verbatim into the *Deps. */
export interface RunOptions extends ProviderChoice {
  providerModel?: string;
  reviewModel?: string;
  noSimplify?: boolean;
  verifyCmd?: string;
  visualProofCmd?: string;
  /** When true, run the conformance stage (opt-in; default off). */
  conformance?: boolean;
  /** Model override for the conformance stage (e.g. 'opus'). */
  conformanceModel?: string;
}

/** Extract the shared RunOptions fields from a `run` or `watch` command (or any compatible shape). */
export function pickRunOptions(cmd: Readonly<Partial<RunOptions>>): RunOptions {
  return {
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    ...(cmd.providerModel !== undefined ? { providerModel: cmd.providerModel } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    ...(cmd.noSimplify !== undefined ? { noSimplify: cmd.noSimplify } : {}),
    ...(cmd.verifyCmd !== undefined ? { verifyCmd: cmd.verifyCmd } : {}),
    ...(cmd.visualProofCmd !== undefined ? { visualProofCmd: cmd.visualProofCmd } : {}),
    ...(cmd.conformance !== undefined ? { conformance: cmd.conformance } : {}),
    ...(cmd.conformanceModel !== undefined ? { conformanceModel: cmd.conformanceModel } : {}),
  };
}

/** Shared dependencies for all source-backed issue runners. */
export interface RunIssueDeps extends RunOptions {
  auth?: AgentAuth;
  repoPath: string;
  proxyUrl?: string;
  network?: string;
  llmProxy?: LlmProxyDep;
  reuse?: boolean;
  forkN?: number;
  reviewGate?: boolean;
}

/** Semantic kind of a proof failure; adapters map it to a platform label string. */
export type ProofFailureKind = 'verify' | 'visual-proof';

/** Input to the per-source publishVerdict hook (platform-neutral subset of PublishReviewVerdictInput). */
export interface PublishVerdictInput {
  /** Full PR or MR URL returned by publishForReview. */
  prUrl: string;
  /** The commit SHA — also the dedupe marker embedded in the comment. */
  headSha: string;
  /** The 'reviewer' StageOutcome. Missing → hard error (no-silence guarantee). */
  reviewerOutcome?: StageOutcome | undefined;
  /** The 'conformance' StageOutcome. Optional; when present appends a ## Conformance section. */
  conformanceOutcome?: StageOutcome | undefined;
  /** Attribution string e.g. "codex" or "claude/sonnet". */
  attribution: string;
  /** When true, blocking (high/critical) findings gate the PR/MR. */
  gate?: boolean;
}

/** Per-source seam: fetch/prepare, extra secrets, id derivation, stage set, extra variables, PR link-back. */
export interface SourceAdapter {
  /** Fetch the task and any source-specific context. Runs on the host. */
  prepare(issueRef: string): Promise<{ task: Task; skills?: SkillRegistry }>;
  /** Extra sandbox secrets merged in before agent secrets (e.g. LINEAR_API_KEY). */
  secrets?: Record<string, string>;
  /** Derive the worktree/task id from the fetched task. */
  taskId(task: Task): string;
  /** Base pipeline stages (canonical, or implementer-swapped for Linear). */
  stages(): PipelineStage[];
  /** Extra prompt variables (e.g. ISSUE for Linear). */
  variables?(issueRef: string, task: Task): Record<string, string>;
  /** Whether the review body should include source-control auto-close syntax for this task id. */
  closeIssueOnMerge?: boolean;
  /** CLI used to open the draft PR/MR for review. Default 'gh'. GitLab supplies 'glab'. */
  reviewCli?: 'gh' | 'glab';
  /** Post the reviewer verdict (+ optional conformance section) onto the opened PR/MR. */
  publishVerdict(input: PublishVerdictInput): Promise<void>;
  /** Add a proof-failure label to the opened PR/MR (best-effort; must never throw). */
  addFailureLabel(prUrl: string, kind: ProofFailureKind): Promise<void>;
  /** Write the PR link back onto the source issue. */
  linkPr(issueRef: string, task: Task, prUrl: string): Promise<void>;
}

/** Shared result shape for all source-backed issue runners. */
export interface RunIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
}

/** Shared pipeline body for GitHub and Linear issue runners, parameterised by a SourceAdapter. */
export async function runSourcedIssue(
  issueRef: string,
  deps: RunIssueDeps,
  adapter: SourceAdapter,
): Promise<RunIssueResult> {
  const { task, skills } = await adapter.prepare(issueRef);

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
        ...(adapter.secrets ?? {}),
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(deps.network !== undefined ? { network: deps.network } : {}),
    });

    const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath);
    const ctx = await prepareContext(
      {
        taskId: adapter.taskId(task),
        localRepoPath: deps.repoPath,
        sandbox,
        agentName: agents.agent.name,
        ...(agents.reviewAgent !== undefined ? { reviewAgentName: agents.reviewAgent.name } : {}),
        ...(deps.reuse !== undefined ? { reuse: deps.reuse } : {}),
      },
      skills !== undefined ? { skills } : {},
    );
    try {
      const pipeline = assembleReviewPipeline(adapter.stages(), agents, deps);
      const outcomes = await runStages(ctx, pipeline, {
        agent: agents.agent,
        variables: {
          ...taskToVariables(task),
          ...(adapter.variables?.(issueRef, task) ?? {}),
          RETROSPECTIVE_MEMORY: retrospectiveMemory,
        },
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

      if (verification !== undefined) await persistVerification(deps.repoPath, ctx.taskId, verification);
      if (visualProof !== undefined) await persistVisualProof(deps.repoPath, ctx.taskId, visualProof);

      const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
      if (!commit.committed) {
        await persistStageOutcomes(deps.repoPath, outcomes);
        return { task };
      }
      const baseBody = reviewRequestBody(task.id, { closeIssueOnMerge: !!adapter.closeIssueOnMerge });
      const body = [
        baseBody,
        verification !== undefined ? proofBlock(verification) : undefined,
        visualProof !== undefined ? visualProofBlock(visualProof) : undefined,
      ].filter((s): s is string => s !== undefined).join('\n\n');
      const pr = await publishForReview(ctx, { title: `${task.title} (${task.id})`, body, draft: true, ...(adapter.reviewCli !== undefined ? { cli: adapter.reviewCli } : {}) });
      const reviewerOutcome = outcomes.find((o) => o.name === 'reviewer');
      const conformanceOutcome = outcomes.find((o) => o.name === 'conformance');
      await adapter.publishVerdict({
        prUrl: pr.prUrl,
        headSha: commit.sha!,
        reviewerOutcome,
        conformanceOutcome,
        attribution: buildReviewerAttribution(reviewerOutcome, agents.agent.name),
        ...(deps.reviewGate === true ? { gate: true } : {}),
      });
      await persistStageOutcomes(deps.repoPath, outcomes, pr.prUrl);
      if (verification !== undefined && !verification.passed) await adapter.addFailureLabel(pr.prUrl, 'verify');
      if (visualProof !== undefined && !visualProof.passed) await adapter.addFailureLabel(pr.prUrl, 'visual-proof');
      await adapter.linkPr(issueRef, task, pr.prUrl);
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
