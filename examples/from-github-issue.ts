import { runGithubIssue, githubDepsFromEnv } from '../src/runners/github.js';

/**
 * Full Vanguard loop with a GitHub Issue as the ONLY source of truth (no Linear): issue = input,
 * draft PR = review, everything in one repo. (Same logic as `vanguard run --github`.)
 *
 * Requires: the vanguard-sandbox image (docker/build.sh), an authenticated `gh`, auth in the env
 * (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY), and running from a clone of the target repo.
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Personal/Claude OAuth/credential") \
 *     pnpm tsx examples/from-github-issue.ts 123
 */
async function main(): Promise<void> {
  const issueRef = process.argv[2];
  if (issueRef === undefined) {
    throw new Error('Provide an issue number: pnpm tsx examples/from-github-issue.ts <number>');
  }
  const repoPath = process.env.REPO_PATH ?? process.cwd();
  const deps = await githubDepsFromEnv(repoPath, process.env.GITHUB_REPO);
  const result = await runGithubIssue(issueRef, deps);
  console.log(`Task: ${result.task.id} — ${result.task.title}`);
  console.log(
    result.prUrl === undefined
      ? 'No changes to commit — finishing without a PR.'
      : `PR for review: ${result.prUrl}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
