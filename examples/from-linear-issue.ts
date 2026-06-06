import { runLinearIssue, linearDepsFromEnv } from '../src/runners/linear.js';

/**
 * Full Vanguard loop with a Linear issue as the source of truth and GitHub as the review surface.
 * The agent reads the issue from inside the sandbox via the injected linear-cli skill, implements it,
 * opens a draft PR, then comments the PR link back onto the issue. (Same logic as `vanguard run --linear`.)
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
  const result = await runLinearIssue(issueRef, linearDepsFromEnv());
  console.log(`Task: ${result.task.id} — ${result.task.title}`);
  console.log(
    result.prUrl === undefined
      ? 'No changes to commit — finishing without a PR.'
      : `PR for review: ${result.prUrl} (linked back onto ${result.task.id})`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
