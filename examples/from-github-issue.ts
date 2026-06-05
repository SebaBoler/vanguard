import { execa } from 'execa';
import {
  GitHubTaskFetcher,
  taskToVariables,
  DockerSandboxProvider,
  ClaudeCodeProvider,
  prepareContext,
  runStages,
  implementReviewSimplifyStages,
  commitStage,
  publishForReview,
  disposeContext,
} from '../src/index.js';

/**
 * Pełna pętla Vanguard z GitHub Issue jako JEDYNYM źródłem prawdy (bez Linear).
 * GitHub Issue = wejście, GitHub PR = review. Wszystko w jednym repo.
 *
 * Wymaga: obrazu vanguard-sandbox (docker/build.sh), zalogowanego `gh`,
 * ANTHROPIC_API_KEY w env, i uruchomienia z klona docelowego repo (origin = to repo).
 *
 *   ANTHROPIC_API_KEY=$(op read "op://Vault/Anthropic/credential") \
 *     pnpm tsx examples/from-github-issue.ts 123
 */
async function main(): Promise<void> {
  const issueRef = process.argv[2];
  if (issueRef === undefined) {
    throw new Error('Podaj numer issue: pnpm tsx examples/from-github-issue.ts <numer>');
  }
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    throw new Error('Brak ANTHROPIC_API_KEY w środowisku — wstrzyknij z vaulta przed uruchomieniem.');
  }

  const repoPath = process.env.REPO_PATH ?? process.cwd();
  const repoSlug = process.env.GITHUB_REPO ?? (await detectRepoSlug(repoPath));

  const task = await new GitHubTaskFetcher(repoSlug).fetch(issueRef);
  console.log(`Zadanie: ${task.id} — ${task.title}`);

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    forwardEnv: ['ANTHROPIC_API_KEY'],
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
  });

  const taskId = `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const ctx = await prepareContext({ taskId, localRepoPath: repoPath, sandbox });
  try {
    const outcomes = await runStages(ctx, implementReviewSimplifyStages(), {
      agent: new ClaudeCodeProvider(),
      variables: taskToVariables(task),
    });
    for (const outcome of outcomes) {
      const { completed, turns, costUsd } = outcome.result;
      console.log(`  ${outcome.name}: completed=${completed} turns=${turns} cost=$${costUsd ?? 0}`);
    }

    const commit = await commitStage(ctx, { message: `feat: ${task.title} (${task.id})` });
    if (!commit.committed) {
      console.log('Brak zmian do commita — kończę bez PR.');
      return;
    }

    const pr = await publishForReview(ctx, {
      title: task.title,
      body: `Automatyczna realizacja ${task.id} przez Vanguard.\n\n${task.description}`,
      draft: true,
    });
    console.log(`PR do review: ${pr.prUrl}`);
  } finally {
    await disposeContext(ctx);
  }
}

/** Wyciąga slug owner/repo z origin remote. */
async function detectRepoSlug(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd });
  const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match?.[1] === undefined) throw new Error(`Nie rozpoznano repo z origin: ${stdout.trim()}`);
  return match[1];
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
