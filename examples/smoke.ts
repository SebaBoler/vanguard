import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { run, DockerSandboxProvider, ClaudeCodeProvider, authFromEnv, authSecrets } from '../src/index.js';

/**
 * Live smoke: uruchamia prawdziwego agenta w obrazie vanguard-sandbox na świeżym repo.
 * Wymaga zbudowanego obrazu (docker/build.sh) oraz uwierzytelnienia w środowisku procesu:
 * CLAUDE_CODE_OAUTH_TOKEN (subskrypcja, domyślnie) albo ANTHROPIC_API_KEY (API).
 * Dokładnie jeden sekret trafia do sandboxa przez tmpfs, nie przez argv.
 *
 * Uruchom (sekret z 1Password, nigdy w repo):
 *   CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Vault/Claude/oauth-token") pnpm tsx examples/smoke.ts
 */
async function main(): Promise<void> {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Ustaw CLAUDE_CODE_OAUTH_TOKEN (subskrypcja) lub ANTHROPIC_API_KEY (API) przed uruchomieniem.');
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
      'Utwórz w bieżącym katalogu plik HELLO.txt o treści "hi". Gdy skończysz, napisz dokładnie <promise>COMPLETE</promise>.',
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
