import { watchLinear, watchGithub, watchGithubProject } from '../runners/watch.js';
import { githubDepsFromEnv } from '../runners/github.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { authFromEnv } from '../agents/auth.js';
import type { AgentAuth } from '../agents/auth.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { Command } from './args.js';

type WatchCommand = Extract<Command, { kind: 'watch' }>;

/** Run the autonomous watch loop for the chosen source (poll -> claim -> run -> review), with egress. */
export async function watchCommand(cmd: WatchCommand): Promise<void> {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const ctx = await startSandboxContext({ egress: cmd.egress, llmProxy: cmd.llmProxy === true, auth });

  const labelSuffix = cmd.label !== undefined ? ` labeled "${cmd.label}"` : '';
  console.log(`watch[${cmd.source}]: polling every ${cmd.intervalMs / 1000}s for items${labelSuffix}. Ctrl-C to stop.`);
  try {
    if (cmd.source === 'linear') {
      await watchLinearSource(cmd, auth, ctx, controller.signal);
    } else if (cmd.source === 'project') {
      await watchGithubProjectSource(cmd, auth, ctx, controller.signal);
    } else {
      await watchGithubSource(cmd, auth, ctx, controller.signal);
    }
  } finally {
    await ctx.destroy();
  }
}

async function watchLinearSource(
  cmd: WatchCommand,
  auth: AgentAuth,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so Vanguard can read and update Linear issues.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  if (cmd.label === undefined) throw new Error('--label is required for linear watch source');
  await watchLinear({
    deps: {
      auth,
      linearKey,
      skillsDir,
      repoPath: cmd.repoPath,
      ...(ctx.proxyUrl !== undefined && ctx.network !== undefined ? { proxyUrl: ctx.proxyUrl, network: ctx.network } : {}),
      ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    },
    label: cmd.label,
    triggerState: cmd.triggerState ?? 'unstarted',
    claimedState: cmd.claimedState ?? 'In Progress',
    reviewState: cmd.reviewState ?? 'In Review',
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    signal,
    ...(cmd.team !== undefined ? { team: cmd.team } : {}),
  });
}

async function buildGithubDeps(cmd: WatchCommand, auth: AgentAuth, ctx: SandboxContext) {
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug);
  deps.auth = auth;
  if (ctx.proxyUrl !== undefined && ctx.network !== undefined) {
    deps.proxyUrl = ctx.proxyUrl;
    deps.network = ctx.network;
  }
  if (ctx.llmProxy !== undefined) deps.llmProxy = ctx.llmProxy;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  return deps;
}

async function watchGithubSource(
  cmd: WatchCommand,
  auth: AgentAuth,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  if (cmd.label === undefined) throw new Error('--label is required for github watch source');
  const deps = await buildGithubDeps(cmd, auth, ctx);
  await watchGithub({
    deps,
    label: cmd.label,
    claimedLabel: cmd.claimedState ?? 'vanguard:running',
    reviewLabel: cmd.reviewState ?? 'vanguard:review',
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    signal,
  });
}

async function watchGithubProjectSource(
  cmd: WatchCommand,
  auth: AgentAuth,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  if (cmd.projectNumber === undefined) throw new Error('--project <number> is required for project watch source');
  const deps = await buildGithubDeps(cmd, auth, ctx);
  await watchGithubProject({
    deps,
    projectNumber: cmd.projectNumber,
    triggerStatus: cmd.triggerState ?? 'Todo',
    claimedStatus: cmd.claimedState ?? 'In Progress',
    reviewStatus: cmd.reviewState ?? 'In Review',
    ...(cmd.label !== undefined ? { label: cmd.label } : {}),
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    signal,
  });
}
