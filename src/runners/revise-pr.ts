import { execa } from 'execa';
import { parsePullRequestRef, fetchPullRequestForReview, postPullRequestReview, commentPullRequest } from './pr-review.js';
import {
  fetchPullRequestFeedback,
  selectActionableFeedback,
  buildRevisionPrompt,
  replyAndResolveThread,
  countRevisionRoundsFromFeedback,
  revisionMarker,
  buildItemReply,
  buildRevisionSummary,
  parseRevisionDiff,
  formatFileChanges,
  describeItemChange,
  guardedPoint,
} from './pr-feedback.js';
import type { FeedbackItem } from './pr-feedback.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import {
  implementReviewSimplifyStages,
  runStages,
  commitStage,
  pushToExistingBranch,
  withStageProvider,
  withStageModel,
  withStageModelExcept,
  withStageFallback,
} from '../pipeline/pipeline.js';
import { defaultGhRunner } from '../tasks/github.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { authSecrets } from '../agents/auth.js';
import { selectAgents } from '../agents/registry.js';
import { GITHUB_REVIEW_LABEL } from '../github-labels.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestForReview } from './pr-review.js';
import type { CommandRunner } from '../pipeline/pipeline.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, SelectedAgents } from '../agents/registry.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider } from '../agents/provider.js';

const NEEDS_REVISION_LABEL = 'needs revision';
const VANGUARD_REVISING_LABEL = 'vanguard:revising';
const DEFAULT_MAX_ROUNDS = 2;
const HAND_BACK_LABELS = { remove: [NEEDS_REVISION_LABEL, VANGUARD_REVISING_LABEL], add: [GITHUB_REVIEW_LABEL] };

export interface ReviseGithubPrDeps extends ProviderChoice {
  auth?: AgentAuth;
  repoPath: string;
  repoSlug?: string;
  gh?: GhRunner;
  /** LLM-proxy sidecar wiring (from startSandboxContext when --llm-proxy is active). */
  llmProxy?: LlmProxyDep;
  /** Egress proxy URL for the sandbox (from startSandboxContext when --egress is active). */
  proxyUrl?: string;
  /** Docker network for the sandbox (from startSandboxContext). */
  network?: string;
  /** Model for the implementer/simplifier stages. */
  providerModel?: string;
  /** Model for the review stage. */
  reviewModel?: string;
  /** Skip the simplifier stage. */
  noSimplify?: boolean;
  /** Maximum revision rounds before capping (default 2). */
  maxRounds?: number;
  /** Extra logins to treat as bots (beyond the built-in heuristic). */
  botLogins?: string[];
  log?: (line: string) => void;
  // Test hooks
  /** Injected sandbox provider (avoids Docker in unit tests). */
  _sandbox?: IsolatedSandboxProvider;
  /** Injected agent provider (avoids real provider CLIs and credential checks in unit tests). */
  _agent?: AgentProvider;
  /** Injected WorktreeManager (avoids requiring a real git remote in unit tests). */
  _worktrees?: WorktreeManager;
  /** Injected CommandRunner for git push (pushToExistingBranch). */
  _pushRunner?: CommandRunner;
  /**
   * Override the baseBranch passed to prepareContext. When set, the git fetch step is skipped.
   * Use in tests to point at a local branch instead of origin/<headRefName>.
   */
  _baseBranch?: string;
}

export interface ReviseGithubPrResult {
  pr: PullRequestForReview;
  /** Number of feedback items addressed this round (threads replied+resolved, non-thread items commented on). */
  addressed: number;
  committed: boolean;
  pushed: boolean;
  undrafted: boolean;
}

function editPrLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['pr', 'edit', String(number), '--repo', repoSlug];
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  for (const label of labels.add ?? []) args.push('--add-label', label);
  return gh(args);
}

/**
 * Run one PR revision round: read human review feedback, apply fixes on the existing PR branch,
 * reply to and resolve addressed threads, un-draft the PR, and flip the labels.
 */
export async function runRevisePullRequest(prRef: string, deps: ReviseGithubPrDeps): Promise<ReviseGithubPrResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const log = deps.log ?? console.log;
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const target = parsePullRequestRef(prRef, deps.repoSlug);
  log(`revise-pr ${target.repoSlug}#${target.number}: fetch -> pr & feedback`);
  const [pr, fb] = await Promise.all([
    fetchPullRequestForReview(target, gh),
    fetchPullRequestFeedback(target, gh, log),
  ]);

  const actionable = selectActionableFeedback(fb, {
    headRefOid: pr.headRefOid,
    ...(deps.botLogins !== undefined ? { botLogins: deps.botLogins } : {}),
  });

  if (actionable.length === 0) {
    log(`revise-pr ${target.repoSlug}#${target.number}: no actionable feedback — skipping`);
    return { pr, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  const rounds = countRevisionRoundsFromFeedback(fb);
  if (rounds >= maxRounds) {
    const capMsg = `Revision cap reached (${rounds}/${maxRounds} rounds). No further automated revisions will be applied.`;
    log(`revise-pr ${target.repoSlug}#${target.number}: cap -> ${rounds} rounds, posting notice`);
    await postPullRequestReview(target, capMsg, 'comment', gh);
    await editPrLabels(gh, target.repoSlug, target.number, HAND_BACK_LABELS);
    return { pr, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  const agents: SelectedAgents =
    deps._agent !== undefined
      ? {
          agent: deps._agent,
          secrets: {},
          proxySecrets: {},
          injectAnthropicAuth: true,
        }
      : selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });

  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies.openai);
    const sandbox =
      deps._sandbox ??
      new DockerSandboxProvider({
        image: 'vanguard-sandbox:latest',
        secrets: {
          ...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth
            ? authSecrets(deps.auth)
            : {}),
          ...agents.secrets,
        },
        ...sandboxResourceLimits(),
        ...(env !== undefined ? { env } : {}),
        ...(deps.network !== undefined ? { network: deps.network } : {}),
      });

    // Fetch the PR branch locally so the worktree starts from PR head, not main.
    let baseBranch: string;
    if (deps._baseBranch !== undefined) {
      baseBranch = deps._baseBranch;
    } else {
      await execa('git', ['fetch', 'origin', pr.headRefName], { cwd: deps.repoPath });
      baseBranch = 'FETCH_HEAD';
    }

    const taskId = `revise-pr-${target.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${target.number}`;
    const ctx = await prepareContext(
      { taskId, localRepoPath: deps.repoPath, sandbox, baseBranch, agentName: agents.agent.name },
      { ...(deps._worktrees !== undefined ? { worktrees: deps._worktrees } : {}) },
    );
    try {
      const allStages = implementReviewSimplifyStages();
      const base = deps.noSimplify === true ? allStages.filter((s) => s.name !== 'simplifier') : allStages;
      let pipeline = agents.reviewAgent !== undefined ? withStageProvider(base, agents.reviewAgent) : base;
      if (deps.providerModel !== undefined) {
        const crossProviderReview =
          deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
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

      const prompt = buildRevisionPrompt(pr, actionable);
      // Override the implementer's promptTemplate with the revision prompt.
      pipeline = pipeline.map((stage) => (stage.name === 'implementer' ? { ...stage, promptTemplate: prompt } : stage));

      log(`revise-pr ${target.repoSlug}#${target.number}: agent -> implementing`);
      await runStages(ctx, pipeline, { agent: agents.agent });

      // Capture round diff BEFORE commit — post-commit git diff HEAD is empty.
      const revisionDiff = await ctx.wm.diff(ctx.worktreePath);

      log(`revise-pr ${target.repoSlug}#${target.number}: commit -> staging`);
      const commit = await commitStage(ctx, {
        message: `fix: address review feedback (${target.repoSlug}#${target.number})`,
      });

      if (!commit.committed) {
        log(`revise-pr ${target.repoSlug}#${target.number}: no changes — skipping push`);
        return { pr, addressed: 0, committed: false, pushed: false, undrafted: false };
      }

      log(`revise-pr ${target.repoSlug}#${target.number}: push -> ${pr.headRefName}`);
      await pushToExistingBranch(ctx, {
        prHeadRef: pr.headRefName,
        ...(deps._pushRunner !== undefined ? { runner: deps._pushRunner } : {}),
      });

      const sha = commit.sha ?? 'unknown';

      // Derive a diff-true "what changed" point for each feedback item.
      const diffFiles = parseRevisionDiff(revisionDiff);
      const globalPoint = formatFileChanges(diffFiles, 3, 3);
      const pointFor = (item: FeedbackItem): string => {
        const candidate = describeItemChange(item, diffFiles) || globalPoint;
        return guardedPoint(candidate, revisionDiff);
      };

      // Reply to and resolve each addressed thread (one reply per unique thread).
      // Map each threadId to its first actionable item to derive a per-thread point.
      const threadIdToItem = new Map<string, FeedbackItem>();
      for (const item of actionable) {
        if (item.source === 'thread' && item.threadId !== undefined && !threadIdToItem.has(item.threadId)) {
          threadIdToItem.set(item.threadId, item);
        }
      }
      await Promise.all(
        [...threadIdToItem.entries()].map(([threadId, item]) => {
          const p = pointFor(item);
          const detail = p ? `: ${p}` : '.';
          return replyAndResolveThread(threadId, `Addressed in commit ${sha}${detail}\n\n${revisionMarker(pr.headRefOid)}`, gh);
        }),
      );

      // Post a per-item referencing reply for each non-threadable feedback item.
      const nonThreadItems = actionable.filter((item) => item.source !== 'thread');
      await Promise.all(
        nonThreadItems.map((item) => commentPullRequest(target, buildItemReply(item, pointFor(item), sha, pr.headRefOid), gh)),
      );

      // Post the single final round summary.
      const summaryText = buildRevisionSummary({
        repoSlug: target.repoSlug,
        number: target.number,
        headRefOid: pr.headRefOid,
        commitSha: sha,
        addressed: actionable.map((item) => ({ item, point: pointFor(item) })),
        deferred: [],
        verification: { typecheck: 'unknown', test: 'unknown' },
      });
      await commentPullRequest(target, summaryText, gh);

      log(`revise-pr ${target.repoSlug}#${target.number}: undraft -> pr ready`);
      await gh(['pr', 'ready', String(target.number), '--repo', target.repoSlug]);

      log(`revise-pr ${target.repoSlug}#${target.number}: labels -> needs-human-review`);
      await editPrLabels(gh, target.repoSlug, target.number, HAND_BACK_LABELS);

      return {
        pr,
        addressed: actionable.length,
        committed: true,
        pushed: true,
        undrafted: true,
      };
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
