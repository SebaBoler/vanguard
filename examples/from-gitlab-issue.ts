import { runGitlabIssue, gitlabDepsFromEnv } from '../src/runners/gitlab.js';

/**
 * Full Vanguard loop with a GitLab Issue as the ONLY source of truth: issue = input,
 * draft MR = review, everything in one project. (Same logic as `vanguard run --gitlab`.)
 *
 * Requires: the vanguard-sandbox image (docker/build.sh), an authenticated `glab`
 * (GITLAB_TOKEN env or `glab auth login`), auth in the env
 * (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY), and running from a clone of the target repo.
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Personal/Claude OAuth/credential") \
 *   GITLAB_TOKEN=$(op read "op://Development/gitlab-pat/token") \
 *     pnpm tsx examples/from-gitlab-issue.ts group/project#42
 *
 * The ref can be:
 *   group/project#42   — full project path + IID
 *   42                 — bare IID (requires GITLAB_PROJECT env or --gitlab-project)
 */
async function main(): Promise<void> {
  const issueRef = process.argv[2];
  if (issueRef === undefined) {
    throw new Error('Provide an issue ref: pnpm tsx examples/from-gitlab-issue.ts <group/project#iid>');
  }
  const repoPath = process.env.REPO_PATH ?? process.cwd();
  const deps = await gitlabDepsFromEnv(repoPath, process.env.GITLAB_PROJECT);
  const result = await runGitlabIssue(issueRef, deps);
  console.log(`Task: ${result.task.id} — ${result.task.title}`);
  console.log(
    result.prUrl === undefined
      ? 'No changes to commit — finishing without an MR.'
      : `MR for review: ${result.prUrl}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
