import { LinearCliTaskFetcher, linkLinearIssue } from '../tasks/linear-cli.js';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, implementReviewSimplifyStages, withStageProvider, commitStage, publishForReview } from '../pipeline/pipeline.js';
import { fanOut } from '../pipeline/fan-out.js';
import { authFromEnv, authSecrets } from '../agents/auth.js';
import { persistStageOutcomes } from '../core/run-record.js';
import { egressEnv } from '../sandbox/egress-proxy.js';
import { skillRegistryFromDirectory } from '../context/skill-registry.js';
import type { RunContext } from '../core/vanguard.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { Task, SubTask } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';

/** Everything needed to run a single Linear issue end to end. */
export interface RunLinearIssueDeps extends ProviderChoice {
  auth: AgentAuth;
  linearKey: string;
  repoPath: string;
  skillsDir: string;
  /** When set, route the sandbox's egress through this proxy URL (HTTPS_PROXY). */
  proxyUrl?: string;
  /** When set, join the sandbox to this docker network (the hard egress enclave). */
  network?: string;
  /** When true, reuse an existing vanguard/<taskId>-* branch/worktree instead of minting a new run id. */
  reuse?: boolean;
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

  const agents = selectAgents(deps);

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    secrets: { ...authSecrets(deps.auth), LINEAR_API_KEY: deps.linearKey, ...agents.secrets },
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
    ...(deps.proxyUrl !== undefined ? { env: egressEnv(deps.proxyUrl) } : {}),
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });

  const ctx = await prepareContext(
    { taskId: `linear-${task.id.toLowerCase()}`, localRepoPath: deps.repoPath, sandbox, ...(deps.reuse !== undefined ? { reuse: deps.reuse } : {}) },
    { skills },
  );
  try {
    const pipeline = agents.reviewAgent !== undefined ? withStageProvider(stages(), agents.reviewAgent) : stages();
    const outcomes = await runStages(ctx, pipeline, {
      agent: agents.agent,
      variables: { ...taskToVariables(task), ISSUE: issueRef },
    });
    const prUrl = await commitAndPublish(ctx, task);
    await persistStageOutcomes(deps.repoPath, outcomes, prUrl);
    if (prUrl === undefined) return { task };
    await linkLinearIssue(task.id, prUrl);
    return { task, prUrl };
  } finally {
    await disposeContext(ctx);
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
export function linearDepsFromEnv(): RunLinearIssueDeps {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR to a directory of skills (e.g. a clone of schpet/linear-cli /skills).');
  }
  return { auth, linearKey, skillsDir, repoPath: process.env.REPO_PATH ?? process.cwd() };
}

/** Commit the agent's work and open a draft PR; returns the PR url, or undefined when nothing changed. */
async function commitAndPublish(ctx: RunContext, task: Task): Promise<string | undefined> {
  const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
  if (!commit.committed) return undefined;
  const pr = await publishForReview(ctx, {
    title: `${task.title} (${task.id})`,
    body: `Automated implementation of ${task.id} by Vanguard.`,
    draft: true,
  });
  return pr.prUrl;
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
    'write code, add or update NOTES.md summarising the issue instead. When done, write <promise>COMPLETE</promise>.',
    '',
    'Title: {{TITLE}}',
  ].join('\n');
  return [{ ...implementer, promptTemplate: readAndImplement }, ...base.slice(1)];
}
