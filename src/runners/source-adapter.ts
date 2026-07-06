import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext, runAgent } from '../core/vanguard.js';
import { runStages, assembleReviewPipeline, sandboxComplete, commitStage, publishForReview, planImplementReviewStages, STAGE } from '../pipeline/pipeline.js';
import { buildReviewerAttribution } from '../pipeline/review-publish.js';
import { authSecrets } from '../agents/auth.js';
import { persistStageOutcomes, persistVerification, persistVisualProof } from '../core/run-record.js';
import { scanForSecrets } from '../core/secret-scan.js';
import type { SecretBlock } from '../core/secret-scan.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback, proofBlock, verifySkippedBlock } from '../pipeline/verify.js';
import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { reviewRequestBody } from './review-body.js';
import {
  parseSpecManifest,
  checkConformance,
  renderConformanceFeedback,
  scanCommitClosingKeywords,
  commitLeakWarningBlock,
  PASSING_RESULT,
} from '../pipeline/conformance-gate.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { ConformanceResult } from '../pipeline/conformance-gate.js';
import type { VerificationResult } from '../pipeline/verify.js';
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
  /** Git author for the commit (default: `Vanguard <vanguard@local>`). Set via --commit-author. */
  commitAuthor?: { name: string; email: string };
  /**
   * When true, run a dedicated planning stage first (opus, high effort) before implement/review — the
   * plan-implement-review pipeline — instead of the source's default implement-first stages. Set via --plan.
   */
  plan?: boolean;
  /** Base branch to branch off and target the PR at (default: `main`). Set via --base. */
  baseBranch?: string;
}

/**
 * Extract the shared RunOptions fields from a `run` or `watch` command (or any compatible shape).
 *
 * Booleans (`noSimplify`, `conformance`) are copied on `!== undefined`, relying on the parse-time
 * invariant that the CLI only ever emits `true` or omits them. A future caller passing an explicit
 * `false` will therefore propagate it — a conscious choice, not a dropped flag.
 */
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
    ...(cmd.commitAuthor !== undefined ? { commitAuthor: cmd.commitAuthor } : {}),
    ...(cmd.plan !== undefined ? { plan: cmd.plan } : {}),
    ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}),
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
  /**
   * Surface a secret-scan block on the source issue (label + masked comment). Best-effort: must
   * never throw (mirrors addFailureLabel). Called for BOTH the findings block and the scan-error
   * precautionary block.
   */
  signalSecretBlock(issueRef: string, task: Task, block: SecretBlock): Promise<void>;
  /** Write the PR link back onto the source issue. */
  linkPr(issueRef: string, task: Task, prUrl: string): Promise<void>;
}

/** Shared result shape for all source-backed issue runners. */
export interface RunIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
}

/** Cap on implement-session resumes triggered by a failing conformance/verify gate, before falling back to a declared-partial PR. */
const MAX_REPAIR_ITERATIONS = 2;

/**
 * White-label branch id: the trailing issue number (e.g. `gh-…-904` → `904`), else a
 * Conventional-Branch-safe slug of the taskId. Used for `feat/<id>-<hash>` branches in white-label mode.
 */
function branchIdFromTaskId(taskId: string): string {
  const trailingNumber = /(\d+)$/.exec(taskId)?.[1];
  if (trailingNumber !== undefined) return trailingNumber;
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug === '' ? 'task' : slug;
}

/** Shared pipeline body for GitHub and Linear issue runners, parameterised by a SourceAdapter. */
export async function runSourcedIssue(
  issueRef: string,
  deps: RunIssueDeps,
  adapter: SourceAdapter,
): Promise<RunIssueResult> {
  const { task, skills } = await adapter.prepare(issueRef);

  // White-label mode (triggered by --commit-author): the PR is delivered as a plain, human-looking PR.
  // Branch becomes `feat/<issue-number>-<hash>`, the "by Vanguard" attribution and the Vanguard review
  // comment / issue link-back are suppressed. Off by default — everything stays branded as Vanguard.
  const whiteLabel = deps.commitAuthor !== undefined;

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
        ...(deps.baseBranch !== undefined ? { baseBranch: deps.baseBranch } : {}),
        ...(whiteLabel ? { branchPrefix: 'feat/', branchId: branchIdFromTaskId(adapter.taskId(task)) } : {}),
      },
      skills !== undefined ? { skills } : {},
    );
    try {
      // --plan swaps the source's implement-first stages for the plan-implement-review pipeline
      // (opus planner → sonnet implementer → reviewer), so a dedicated planning stage precedes the code.
      const baseStages = deps.plan === true ? planImplementReviewStages() : adapter.stages();
      const pipeline = assembleReviewPipeline(baseStages, agents, deps);
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

      // Deterministic spec-manifest vs diff conformance gate, joined with the verify command into a
      // single shared-cap repair loop: either gate failing resumes the implementer's own session with
      // a combined gap report (bounded, budget/turn caps already apply to the resumed stage) —
      // "iterate the implement loop", not "open PR and hope". Exhausting the cap (or having no
      // resumable session) falls through to a declared-partial PR (reviewRequestBody below), never a
      // silent `Closes` with either gate red.
      const specText = task.comments.map((comment) => comment.body).join('\n');
      const manifest = parseSpecManifest(specText);
      const verifyCmd = await resolveVerifyCommand(ctx.worktreePath, deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {});

      // Resolve the implementer outcome once — the loop only runs while its session is resumable,
      // so its position in `outcomes` is fixed for the duration.
      const implementerIdx = outcomes.findIndex((o) => o.name === STAGE.IMPLEMENTER);
      let resumeSessionId = implementerIdx !== -1 ? outcomes[implementerIdx]?.result.sessionId : undefined;

      let conformance: ConformanceResult = PASSING_RESULT;
      let verification: VerificationResult | undefined;
      let gatePassed = false;
      let repairIterations = 0;
      for (;;) {
        // Only touch the worktree diff when there is a manifest to check against — a legacy/no-manifest
        // spec skips the conformance half of the gate entirely (zero extra work, no spurious `wm.diff` call).
        conformance = manifest !== undefined ? checkConformance(manifest, await ctx.wm.diff(ctx.worktreePath)) : PASSING_RESULT;
        verification = verifyCmd !== undefined ? await runVerification(ctx.sandbox, verifyCmd) : undefined;
        gatePassed = conformance.pass && (verification === undefined || verification.passed);
        if (gatePassed || repairIterations >= MAX_REPAIR_ITERATIONS || resumeSessionId === undefined) break;

        repairIterations += 1;
        console.log(
          `vanguard: gate FAILED for ${task.id} (attempt ${repairIterations}/${MAX_REPAIR_ITERATIONS}) — resuming implement session`,
        );
        const feedback = [
          !conformance.pass ? renderConformanceFeedback(conformance) : undefined,
          verification !== undefined && !verification.passed ? renderVerificationFeedback(verification) : undefined,
        ]
          .filter((s): s is string => s !== undefined)
          .join('\n\n');
        const repaired = await runAgent(ctx, {
          promptTemplate: `${feedback}\n\nWhen every gap above is addressed, write <promise>COMPLETE</promise>.`,
          agent: agents.agent,
          resumeSessionId,
        });
        const prior = outcomes[implementerIdx];
        if (prior !== undefined) outcomes[implementerIdx] = { ...prior, result: repaired };
        resumeSessionId = repaired.sessionId ?? resumeSessionId;
      }
      console.log(`vanguard: gate ${gatePassed ? 'PASSED' : 'FAILED — declaring partial scope'} for ${task.id}`);

      const visualProof = await resolveAndRunVisualProof(
        ctx.sandbox,
        ctx.worktreePath,
        deps.visualProofCmd !== undefined ? { cmd: deps.visualProofCmd } : {},
      );

      if (verification !== undefined) await persistVerification(deps.repoPath, ctx.taskId, verification);
      if (visualProof !== undefined) await persistVisualProof(deps.repoPath, ctx.taskId, visualProof);

      // Gate before commitStage/publishForReview: publishForReview pushes the branch before any
      // label can be attached, so the raw secret must never reach a commit in the first place.
      const outgoing = await ctx.wm.diff(ctx.worktreePath);
      let block: SecretBlock | undefined;
      try {
        const findings = scanForSecrets(outgoing);
        if (findings.length > 0) {
          console.error(
            `vanguard: secret scan blocked publish for ${task.id}:`,
            findings.map((f) => `${f.file} [${f.patternName}] ${f.masked}`).join('; '),
          );
          block = { reason: 'findings', findings };
        }
      } catch (err) {
        console.error(`vanguard: secret scan failed for ${task.id}, blocking publish as a precaution:`, err);
        block = { reason: 'scan-error', message: err instanceof Error ? err.message : String(err) };
      }
      if (block !== undefined) {
        await persistStageOutcomes(deps.repoPath, outcomes);
        await adapter.signalSecretBlock(issueRef, task, block);
        return { task };
      }

      const commit = await commitStage(ctx, {
        message: `feat: ${task.title} (${task.id})`,
        ...(deps.commitAuthor !== undefined
          ? { authorName: deps.commitAuthor.name, authorEmail: deps.commitAuthor.email }
          : {}),
      });
      if (!commit.committed) {
        await persistStageOutcomes(deps.repoPath, outcomes);
        return { task };
      }

      // Verification participates in the Closes/Part-of decision alongside conformance: a red result
      // forces the declared-partial path even when conformance itself passed.
      const verificationFailed = verification !== undefined && !verification.passed;
      const partial = !gatePassed;
      const baseBody = reviewRequestBody(task.id, {
        closeIssueOnMerge: !!adapter.closeIssueOnMerge,
        ...(manifest !== undefined ? { conformance, manifest } : {}),
        ...(verificationFailed ? { verificationFailed: true } : {}),
        ...(whiteLabel ? { hideAttribution: true } : {}),
      });
      // Commit-message closing-keyword scan: a rebase merge closes the issue per commit message
      // regardless of this PR body, so a partial result surfaces any commit-level `Closes #N` leak as
      // a blocking warning. Advisory-only on a full green pass — a legitimate `Closes` is expected there.
      const commitLeaks = partial
        ? scanCommitClosingKeywords(await ctx.wm.commitMessages(ctx.worktreePath, 'main'), task.id)
        : [];
      // White-label mode keeps the body to just the Closes/Part-of line — no automated proof-of-work
      // blocks — so the PR reads like a plain human PR. The quality gate still runs; it only shapes the
      // Closes-vs-Part-of decision baked into baseBody.
      const body = whiteLabel
        ? baseBody
        : [
            baseBody,
            commitLeaks.length > 0 ? commitLeakWarningBlock(commitLeaks) : undefined,
            verification !== undefined ? proofBlock(verification) : verifySkippedBlock(),
            visualProof !== undefined ? visualProofBlock(visualProof) : undefined,
          ].filter((s): s is string => s !== undefined).join('\n\n');
      const pr = await publishForReview(ctx, {
        title: `${task.title} (${task.id})`,
        body,
        draft: true,
        ...(deps.baseBranch !== undefined ? { baseBranch: deps.baseBranch } : {}),
        ...(adapter.reviewCli !== undefined ? { cli: adapter.reviewCli } : {}),
      });
      // White-label mode delivers a plain PR: no Vanguard review comment and no issue link-back comment.
      if (!whiteLabel) {
        const reviewerOutcome = outcomes.find((o) => o.name === STAGE.REVIEWER);
        const conformanceOutcome = outcomes.find((o) => o.name === STAGE.CONFORMANCE);
        await adapter.publishVerdict({
          prUrl: pr.prUrl,
          headSha: commit.sha!,
          reviewerOutcome,
          conformanceOutcome,
          attribution: buildReviewerAttribution(reviewerOutcome, agents.agent.name),
          ...(deps.reviewGate === true ? { gate: true } : {}),
        });
      }
      await persistStageOutcomes(deps.repoPath, outcomes, pr.prUrl);
      if (verification !== undefined && !verification.passed) await adapter.addFailureLabel(pr.prUrl, 'verify');
      if (visualProof !== undefined && !visualProof.passed) await adapter.addFailureLabel(pr.prUrl, 'visual-proof');
      if (!whiteLabel) await adapter.linkPr(issueRef, task, pr.prUrl);
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
