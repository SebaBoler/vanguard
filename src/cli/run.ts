import { runLinearIssue, runLinearParent } from '../runners/linear.js';
import { runGithubIssue, runGithubProject, githubDepsFromEnv } from '../runners/github.js';
import { reapContainers, dockerContainerLister, dockerContainerRemover, pruneWorktrees } from '../core/gc.js';
import { startEgressEnclave } from '../sandbox/egress-network.js';
import { authFromEnv } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { AgentAuth } from '../agents/auth.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { Command } from './args.js';

type RunCommand = Extract<Command, { kind: 'run' }>;

/** Dispatch `vanguard run` to the right source runner, assembling deps from env + flags. */
export async function runCommand(cmd: RunCommand): Promise<void> {
  if (cmd.gcBefore) {
    const reaped = await reapContainers(dockerContainerLister(), dockerContainerRemover());
    await pruneWorktrees(cmd.repoPath);
    console.log(`gc-before: reaped ${reaped.length} stale container(s), pruned worktrees.`);
  }

  const enclave = cmd.egress ? await startEgressEnclave() : undefined;
  if (enclave !== undefined) console.log('egress: sandbox confined to an internal network; only the allowlist proxy can reach out.');
  try {
    if (cmd.source === 'linear') {
      await runLinear(cmd, enclave?.proxyUrl, enclave?.network);
    } else if (cmd.source === 'project') {
      await runProject(cmd, enclave?.proxyUrl, enclave?.network);
    } else {
      await runGithub(cmd, enclave?.proxyUrl, enclave?.network);
    }
  } finally {
    if (enclave !== undefined) await enclave.destroy();
  }
}

function requireAuth(): AgentAuth {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  return auth;
}

function linearDeps(cmd: RunCommand, proxyUrl: string | undefined, network: string | undefined): RunLinearIssueDeps {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  return {
    auth: requireAuth(),
    linearKey,
    skillsDir,
    repoPath: cmd.repoPath,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(cmd.reuse === true ? { reuse: true } : {}),
  };
}

async function runLinear(cmd: RunCommand, proxyUrl: string | undefined, network: string | undefined): Promise<void> {
  const deps = linearDeps(cmd, proxyUrl, network);
  if (!cmd.parent) {
    const result = await runLinearIssue(cmd.id, deps);
    report(result.task.id, result.prUrl);
    return;
  }
  const { parent, outcomes } = await runLinearParent(cmd.id, deps, { concurrency: cmd.concurrency });
  console.log(`Parent: ${parent.id} — ${parent.title} (${parent.children.length} sub-tasks)`);
  reportFanOut(outcomes, parent.children.length);
}

async function runGithub(cmd: RunCommand, proxyUrl: string | undefined, network: string | undefined): Promise<void> {
  if (cmd.parent) throw new Error('--parent is only supported with --linear (GitHub issues have no sub-tasks here).');
  requireAuth();
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug);
  if (proxyUrl !== undefined) deps.proxyUrl = proxyUrl;
  if (network !== undefined) deps.network = network;
  if (cmd.reuse === true) deps.reuse = true;
  const result = await runGithubIssue(cmd.id, deps);
  report(result.task.id, result.prUrl);
}

async function runProject(cmd: RunCommand, proxyUrl: string | undefined, network: string | undefined): Promise<void> {
  const projectNumber = Number(cmd.id);
  if (!Number.isInteger(projectNumber) || projectNumber < 1) {
    throw new Error(`--project expects a board number, got "${cmd.id}".`);
  }
  requireAuth();
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug);
  if (proxyUrl !== undefined) deps.proxyUrl = proxyUrl;
  if (network !== undefined) deps.network = network;
  const { tasks, outcomes } = await runGithubProject(deps, {
    projectNumber,
    concurrency: cmd.concurrency,
    ...(cmd.label !== undefined ? { label: cmd.label } : {}),
  });
  console.log(`Project ${projectNumber} (${deps.repoSlug}): ${tasks.length} task(s)`);
  reportFanOut(outcomes, tasks.length);
}

function report(id: string, prUrl: string | undefined): void {
  console.log(prUrl !== undefined ? `PR for review: ${prUrl} (linked back onto ${id})` : `No changes — no PR for ${id}.`);
}

/** Print a fan-out summary (one line per task + totals). Shared by --parent and --project. */
function reportFanOut<I extends { id: string }, T extends { prUrl?: string }>(
  outcomes: ReadonlyArray<FanOutOutcome<I, T>>,
  total: number,
): void {
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
  console.log(`Done: ${opened} PR(s) opened, ${failed} failed, of ${total}.`);
}
