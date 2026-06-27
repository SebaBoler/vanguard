import { runLinearIssue, runLinearParent } from '../runners/linear.js';
import { runGithubIssue, runGithubProject, githubDepsFromEnv } from '../runners/github.js';
import { runGitlabIssue, gitlabDepsFromEnv } from '../runners/gitlab.js';
import { reapContainers, dockerContainerLister, dockerContainerRemover, pruneWorktrees } from '../core/gc.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
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

  const auth = requireAuth(cmd);
  const ctx = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });

  try {
    if (cmd.source === 'linear') {
      await runLinear(cmd, auth, ctx.proxyUrl, ctx.network, ctx.llmProxy);
    } else if (cmd.source === 'project') {
      await runProject(cmd, ctx.proxyUrl, ctx.network, ctx.llmProxy);
    } else if (cmd.source === 'gitlab') {
      await runGitlab(cmd, ctx.proxyUrl, ctx.network, ctx.llmProxy);
    } else {
      await runGithub(cmd, ctx.proxyUrl, ctx.network, ctx.llmProxy);
    }
  } finally {
    await ctx.destroy();
  }
}

function requireAuth(cmd: RunCommand): AgentAuth | undefined {
  return agentAuthFromEnv({
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
  });
}

function linearDeps(
  cmd: RunCommand,
  auth: AgentAuth | undefined,
  proxyUrl: string | undefined,
  network: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): RunLinearIssueDeps {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  return {
    ...(auth !== undefined ? { auth } : {}),
    linearKey,
    skillsDir,
    repoPath: cmd.repoPath,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(llmProxy !== undefined ? { llmProxy } : {}),
    ...(cmd.reuse === true ? { reuse: true } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    ...(cmd.providerModel !== undefined ? { providerModel: cmd.providerModel } : {}),
    ...(cmd.noSimplify === true ? { noSimplify: true } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    ...(cmd.forkN !== undefined ? { forkN: cmd.forkN } : {}),
    ...(cmd.verifyCmd !== undefined ? { verifyCmd: cmd.verifyCmd } : {}),
    ...(cmd.visualProofCmd !== undefined ? { visualProofCmd: cmd.visualProofCmd } : {}),
    ...(cmd.conformance === true ? { conformance: true } : {}),
    ...(cmd.conformanceModel !== undefined ? { conformanceModel: cmd.conformanceModel } : {}),
  };
}

async function runLinear(
  cmd: RunCommand,
  auth: AgentAuth | undefined,
  proxyUrl: string | undefined,
  network: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): Promise<void> {
  const deps = linearDeps(cmd, auth, proxyUrl, network, llmProxy);
  if (!cmd.parent) {
    const result = await runLinearIssue(cmd.id, deps);
    report(result.task.id, result.prUrl);
    return;
  }
  const { parent, outcomes } = await runLinearParent(cmd.id, deps, { concurrency: cmd.concurrency });
  console.log(`Parent: ${parent.id} — ${parent.title} (${parent.children.length} sub-tasks)`);
  reportFanOut(outcomes, parent.children.length);
}

async function runGithub(
  cmd: RunCommand,
  proxyUrl: string | undefined,
  network: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): Promise<void> {
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd.provider, cmd.reviewProvider);
  if (proxyUrl !== undefined) deps.proxyUrl = proxyUrl;
  if (network !== undefined) deps.network = network;
  if (llmProxy !== undefined) deps.llmProxy = llmProxy;
  if (cmd.reuse === true) deps.reuse = true;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.forkN !== undefined) deps.forkN = cmd.forkN;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;
  if (cmd.visualProofCmd !== undefined) deps.visualProofCmd = cmd.visualProofCmd;
  if (cmd.conformance === true) deps.conformance = true;
  if (cmd.conformanceModel !== undefined) deps.conformanceModel = cmd.conformanceModel;
  const result = await runGithubIssue(cmd.id, deps);
  report(result.task.id, result.prUrl);
}

async function runGitlab(
  cmd: RunCommand,
  proxyUrl: string | undefined,
  network: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): Promise<void> {
  if (cmd.parent) throw new Error('--parent is not supported with --gitlab.');
  // If --gitlab-project is absent, extract project from the ref prefix (group/project#42).
  const projectFromRef = cmd.project === undefined && cmd.id.includes('#')
    ? cmd.id.split('#')[0]
    : undefined;
  const deps = await gitlabDepsFromEnv(cmd.repoPath, cmd.project ?? projectFromRef, cmd.provider, cmd.reviewProvider);
  if (proxyUrl !== undefined) deps.proxyUrl = proxyUrl;
  if (network !== undefined) deps.network = network;
  if (llmProxy !== undefined) deps.llmProxy = llmProxy;
  if (cmd.reuse === true) deps.reuse = true;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;
  if (cmd.visualProofCmd !== undefined) deps.visualProofCmd = cmd.visualProofCmd;
  // GitLab does not support conformance in v1; the flag is ignored here.
  const result = await runGitlabIssue(cmd.id, deps);
  report(result.task.id, result.prUrl);
}

async function runProject(
  cmd: RunCommand,
  proxyUrl: string | undefined,
  network: string | undefined,
  llmProxy: LlmProxyDep | undefined,
): Promise<void> {
  const projectNumber = Number(cmd.id);
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd.provider, cmd.reviewProvider);
  if (proxyUrl !== undefined) deps.proxyUrl = proxyUrl;
  if (network !== undefined) deps.network = network;
  if (llmProxy !== undefined) deps.llmProxy = llmProxy;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.forkN !== undefined) deps.forkN = cmd.forkN;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;
  if (cmd.visualProofCmd !== undefined) deps.visualProofCmd = cmd.visualProofCmd;
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
