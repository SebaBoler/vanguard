import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { run, DockerSandboxProvider, ClaudeCodeProvider } from '../src/index.js';

/**
 * Live smoke: uruchamia prawdziwego agenta w obrazie vanguard-sandbox na świeżym repo.
 * Wymaga zbudowanego obrazu (docker/build.sh) i ANTHROPIC_API_KEY w środowisku procesu.
 * Klucz jest przekazywany przez forwardEnv -> plik env 0600 wewnątrz sandboxa, nie przez argv.
 *
 * Uruchom (klucz z 1Password, nigdy w repo):
 *   ANTHROPIC_API_KEY=$(op read "op://Vault/Anthropic/credential") pnpm tsx examples/smoke.ts
 */
async function main(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    throw new Error('Brak ANTHROPIC_API_KEY w środowisku — wstrzyknij z vaulta przed uruchomieniem.');
  }

  const repo = await mkdtemp(join(tmpdir(), 'vanguard-smoke-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# smoke\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=smoke@vanguard', '-c', 'user.name=smoke', 'commit', '-m', 'init'], { cwd: repo });

  const sandbox = new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    workdir: '/workspace',
    forwardEnv: ['ANTHROPIC_API_KEY'],
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
