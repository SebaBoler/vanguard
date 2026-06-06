import { runLinearIssue, runLinearParent } from '../runners/linear.js';
import { runGithubIssue, githubDepsFromEnv } from '../runners/github.js';
import { authFromEnv } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { AgentAuth } from '../agents/auth.js';
import type { Command } from './args.js';

type RunCommand = Extract<Command, { kind: 'run' }>;

/** Dispatch `vanguard run` to the right source runner, assembling deps from env + flags. */
export async function runCommand(cmd: RunCommand): Promise<void> {
  if (cmd.source === 'linear') {
    await runLinear(cmd);
  } else {
    await runGithub(cmd);
  }
}

function requireAuth(): AgentAuth {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  return auth;
}

function linearDeps(cmd: RunCommand): RunLinearIssueDeps {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  return { auth: requireAuth(), linearKey, skillsDir, repoPath: cmd.repoPath };
}

async function runLinear(cmd: RunCommand): Promise<void> {
  const deps = linearDeps(cmd);
  if (!cmd.parent) {
    const result = await runLinearIssue(cmd.id, deps);
    report(result.task.id, result.prUrl);
    return;
  }
  const { parent, outcomes } = await runLinearParent(cmd.id, deps, { concurrency: cmd.concurrency });
  console.log(`Parent: ${parent.id} — ${parent.title} (${parent.children.length} sub-tasks)`);
  let opened = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.prUrl !== undefined) opened += 1;
      console.log(`  ${outcome.item.id}: ${outcome.value.prUrl ?? 'no changes (no PR)'}`);
    } else {
      failed += 1;
      console.log(`  ${outcome.item.id}: FAILED — ${String(outcome.reason)}`);
    }
  }
  console.log(`Done: ${opened} PR(s) opened, ${failed} failed, of ${parent.children.length} sub-tasks.`);
}

async function runGithub(cmd: RunCommand): Promise<void> {
  if (cmd.parent) throw new Error('--parent is only supported with --linear (GitHub issues have no sub-tasks here).');
  requireAuth();
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug);
  const result = await runGithubIssue(cmd.id, deps);
  report(result.task.id, result.prUrl);
}

function report(id: string, prUrl: string | undefined): void {
  console.log(prUrl !== undefined ? `PR for review: ${prUrl} (linked back onto ${id})` : `No changes — no PR for ${id}.`);
}
