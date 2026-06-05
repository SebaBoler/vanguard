import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { run, DockerSandboxProvider, ClaudeCodeProvider, authFromEnv, authSecrets } from '../src/index.js';

/**
 * Live smoke: runs a real agent in the vanguard-sandbox image against a fresh repo.
 * Requires a built image (docker/build.sh) and authentication in the process environment:
 * CLAUDE_CODE_OAUTH_TOKEN (subscription, default) or ANTHROPIC_API_KEY (API).
 * Exactly one secret reaches the sandbox via tmpfs, not via argv.
 *
 * Run (secret from 1Password, never in the repo):
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Vault/Claude/oauth-token") pnpm tsx examples/smoke.ts
 */
async function main(): Promise<void> {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }

  const repo = await mkdtemp(join(tmpdir(), 'vanguard-smoke-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# smoke\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=smoke@vanguard', '-c', 'user.name=smoke', 'commit', '-m', 'init'], { cwd: repo });

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    workdir: '/workspace',
    secrets: authSecrets(auth),
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 512,
  });

  const result = await run({
    taskId: 'smoke',
    localRepoPath: repo,
    promptTemplate:
      'Create a file HELLO.txt with the content "hi" in the current directory. When done, write exactly <promise>COMPLETE</promise>.',
    sandbox,
    agent: new ClaudeCodeProvider(),
    effort: 'low',
    maxTurns: 4,
  });

  console.log(
    JSON.stringify(
      {
        completed: result.completed,
        exitReason: result.exitReason,
        turns: result.turns,
        sessionId: result.sessionId,
        worktreePreserved: result.worktreePreserved,
        usage: result.usage,
        costUsd: result.costUsd,
        worktreePath: result.worktreePath,
        diffPreview: result.diff?.slice(0, 400),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
