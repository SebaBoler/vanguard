import {
  LinearCliTaskFetcher,
  linkLinearIssue,
  taskToVariables,
  DockerSandboxProvider,
  ClaudeCodeProvider,
  prepareContext,
  runStages,
  implementReviewSimplifyStages,
  commitStage,
  publishForReview,
  disposeContext,
  authFromEnv,
  authSecrets,
  skillRegistryFromDirectory,
} from '../src/index.js';
import type { PipelineStage, Task, AgentAuth } from '../src/index.js';

/** Everything needed to run a single Linear issue end to end. */
export interface RunLinearIssueDeps {
  auth: AgentAuth;
  linearKey: string;
  repoPath: string;
  skillsDir: string;
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
 * fan several out concurrently (see examples/from-linear-parent.ts).
 */
export async function runLinearIssue(issueRef: string, deps: RunLinearIssueDeps): Promise<RunLinearIssueResult> {
  const [task, skills] = await Promise.all([
    new LinearCliTaskFetcher().fetch(issueRef),
    skillRegistryFromDirectory(deps.skillsDir),
  ]);

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    secrets: { ...authSecrets(deps.auth), LINEAR_API_KEY: deps.linearKey },
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
  });

  const ctx = await prepareContext(
    { taskId: `linear-${task.id.toLowerCase()}`, localRepoPath: deps.repoPath, sandbox },
    { skills },
  );
  try {
    await runStages(ctx, stages(), {
      agent: new ClaudeCodeProvider(),
      variables: { ...taskToVariables(task), ISSUE: issueRef },
    });
    const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
    if (!commit.committed) return { task };

    const pr = await publishForReview(ctx, {
      title: `${task.title} (${task.id})`,
      body: `Automated implementation of ${task.id} by Vanguard.`,
      draft: true,
    });
    await linkLinearIssue(task.id, pr.prUrl);
    return { task, prUrl: pr.prUrl };
  } finally {
    await disposeContext(ctx);
  }
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
