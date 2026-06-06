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
import type { PipelineStage } from '../src/index.js';

/**
 * Full Vanguard loop with a Linear issue as the source of truth and GitHub as the review surface.
 * The agent reads the issue itself from inside the sandbox via the injected linear-cli skill
 * (LINEAR_API_KEY is forwarded), implements it, opens a draft PR, then comments the PR link back
 * onto the Linear issue.
 *
 * Requires: the vanguard-sandbox image (docker/build.sh, includes the `linear` CLI), an
 * authenticated `gh`, the linear-cli skill directory, and auth in the env.
 *
 *   LINEAR_API_KEY=$(op read "op://Personal/Linear API/credential") \
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Personal/Claude OAuth/credential") \
 *   REPO_PATH=/tmp/vanguard-e2e SKILLS_DIR=/tmp/linear-cli/skills \
 *     pnpm tsx examples/from-linear-issue.ts TES-1
 */
async function main(): Promise<void> {
  const issueRef = process.argv[2];
  if (issueRef === undefined) {
    throw new Error('Provide a Linear issue id: pnpm tsx examples/from-linear-issue.ts <ID>');
  }
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const repoPath = process.env.REPO_PATH ?? process.cwd();
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR to a directory of skills (e.g. a clone of schpet/linear-cli /skills).');
  }

  const [task, skills] = await Promise.all([
    new LinearCliTaskFetcher().fetch(issueRef),
    skillRegistryFromDirectory(skillsDir),
  ]);
  console.log(`Task: ${task.id} — ${task.title}`);

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    secrets: { ...authSecrets(auth), LINEAR_API_KEY: linearKey },
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
  });

  const taskId = `linear-${task.id.toLowerCase()}`;
  const ctx = await prepareContext({ taskId, localRepoPath: repoPath, sandbox }, { skills });
  try {
    const outcomes = await runStages(ctx, stages(), {
      agent: new ClaudeCodeProvider(),
      variables: { ...taskToVariables(task), ISSUE: issueRef },
    });
    for (const outcome of outcomes) {
      const { completed, turns, costUsd } = outcome.result;
      console.log(`  ${outcome.name}: completed=${completed} turns=${turns} cost=$${costUsd ?? 0}`);
    }

    const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
    if (!commit.committed) {
      console.log('No changes to commit — finishing without a PR.');
      return;
    }

    const pr = await publishForReview(ctx, {
      title: `${task.title} (${task.id})`,
      body: `Automated implementation of ${task.id} by Vanguard.`,
      draft: true,
    });
    console.log(`PR for review: ${pr.prUrl}`);

    await linkLinearIssue(task.id, pr.prUrl);
    console.log(`Linked PR back onto ${task.id} in Linear.`);
  } finally {
    await disposeContext(ctx);
  }
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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
