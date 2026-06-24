import { LinearCliTaskFetcher, linkLinearIssue } from '../tasks/linear-cli.js';
import { implementReviewSimplifyStages, retrospectiveMemoryBlock } from '../pipeline/pipeline.js';
import { fanOut } from '../pipeline/fan-out.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { skillRegistryFromDirectory } from '../context/skill-registry.js';
import { runSourcedIssue } from './source-adapter.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { Task, SubTask } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, ProviderName } from '../agents/registry.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SourceAdapter } from './source-adapter.js';

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
  /** When true, blocking (high/critical) reviewer findings post as --request-changes to block merge. */
  reviewGate?: boolean;
}

export interface RunLinearIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
}

/**
 * The canonical implement/review/simplify pipeline with only the implementer's prompt swapped, so
 * the agent reads the issue from Linear via the injected linear-cli skill. The review and simplify
 * stages stay canonical (no duplicated prompts, no silently dropped review).
 */
function linearStages(): PipelineStage[] {
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

function linearAdapter(deps: RunLinearIssueDeps): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      const [task, skills] = await Promise.all([
        new LinearCliTaskFetcher().fetch(issueRef),
        skillRegistryFromDirectory(deps.skillsDir),
      ]);
      return { task, skills };
    },
    secrets: { LINEAR_API_KEY: deps.linearKey },
    taskId: (task) => `linear-${task.id.toLowerCase()}`,
    stages: linearStages,
    variables: (issueRef: string) => ({ ISSUE: issueRef }),
    async linkPr(_issueRef: string, task: Task, prUrl: string) {
      await linkLinearIssue(task.id, prUrl);
    },
  };
}

/**
 * Run one Linear issue end to end: the agent reads it from inside the sandbox via the injected
 * linear-cli skill, runs the canonical implement/review/simplify pipeline, opens a draft GitHub PR,
 * and comments the PR link back onto the issue. Each call provisions its own sandbox, so callers can
 * fan several out concurrently (see runLinearParent).
 */
export async function runLinearIssue(issueRef: string, deps: RunLinearIssueDeps): Promise<RunLinearIssueResult> {
  return runSourcedIssue(issueRef, deps, linearAdapter(deps));
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
