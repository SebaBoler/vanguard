import { watchLinear, watchGithub, watchGithubProject, watchLinearLoopV1, watchGithubLoopV1, watchGitlab, watchGitlabLoopV1 } from '../runners/watch.js';
import { githubDepsFromEnv } from '../runners/github.js';
import { gitlabDepsFromEnv } from '../runners/gitlab.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { LinearCliTaskFetcher } from '../tasks/linear-cli.js';
import { GitHubTaskFetcher } from '../tasks/github.js';
import { GitLabTaskFetcher } from '../tasks/gitlab.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import { GITLAB_CLAIMED_LABEL, GITLAB_REVIEW_LABEL, GITLAB_SPEC_CLAIMED_LABEL } from '../gitlab-labels.js';
import { formatPreflightReport, runPreflight } from './preflight.js';
import type { AgentAuth } from '../agents/auth.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { Command } from './args.js';
import type { RunSpecGeneratorDeps } from '../runners/spec.js';

type WatchCommand = Extract<Command, { kind: 'watch' }>;

const SPEC_CLAIMED_STATE = 'Speccing'; // Linear default; override with --spec-claimed-state.

/** Run the autonomous watch loop for the chosen source (poll -> claim -> run -> review), with egress. */
export async function watchCommand(cmd: WatchCommand): Promise<void> {
  const report = await runPreflight(cmd);
  for (const line of formatPreflightReport(report)) console.log(line);
  if (!report.ok) throw new Error('preflight failed');

  const auth = agentAuthFromEnv({
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
  });

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const ctx = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });

  const labelSuffix = cmd.label !== undefined ? ` labeled "${cmd.label}"` : '';
  console.log(`watch[${cmd.source}]: polling every ${cmd.intervalMs / 1000}s for items${labelSuffix}. Ctrl-C to stop.`);
  try {
    if (cmd.source === 'linear') {
      await watchLinearSource(cmd, auth, ctx, controller.signal);
    } else if (cmd.source === 'project') {
      await watchGithubProjectSource(cmd, auth, ctx, controller.signal);
    } else if (cmd.source === 'gitlab') {
      await watchGitlabSource(cmd, auth, ctx, controller.signal);
    } else {
      await watchGithubSource(cmd, auth, ctx, controller.signal);
    }
  } finally {
    await ctx.destroy();
  }
}

async function watchLinearSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
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

  const agentDeps = {
    ...(auth !== undefined ? { auth } : {}),
    linearKey,
    skillsDir,
    repoPath: cmd.repoPath,
    ...(ctx.proxyUrl !== undefined && ctx.network !== undefined ? { proxyUrl: ctx.proxyUrl, network: ctx.network } : {}),
    ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    ...(cmd.providerModel !== undefined ? { providerModel: cmd.providerModel } : {}),
    ...(cmd.noSimplify === true ? { noSimplify: true } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    ...(cmd.verifyCmd !== undefined ? { verifyCmd: cmd.verifyCmd } : {}),
    ...(cmd.visualProofCmd !== undefined ? { visualProofCmd: cmd.visualProofCmd } : {}),
  };

  // Loop v1: activated when --spec-state is supplied.
  if (cmd.specState !== undefined) {
    if (cmd.specStateName === undefined || cmd.needsInfoState === undefined) {
      throw new Error('--spec-state-name and --needs-info-state are required with --spec-state for linear loop-v1');
    }
    const specDeps: RunSpecGeneratorDeps = {
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new LinearCliTaskFetcher({
        ...(cmd.team !== undefined ? { team: cmd.team } : {}),
      }),
      sandboxSecrets: { LINEAR_API_KEY: linearKey },
      ...(ctx.proxyUrl !== undefined && ctx.network !== undefined ? { proxyUrl: ctx.proxyUrl, network: ctx.network } : {}),
      ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
    };
    await watchLinearLoopV1({
      spec: {
        deps: specDeps,
        label: cmd.label,
        specTriggerState: cmd.specState,
        specTriggerStateName: cmd.specStateName,
        claimedState: cmd.specClaimedState ?? SPEC_CLAIMED_STATE,
        agentState: cmd.agentState ?? 'Todo',
        needsInfoState: cmd.needsInfoState,
        ...(cmd.team !== undefined ? { team: cmd.team } : {}),
      },
      agent: {
        deps: agentDeps,
        label: cmd.label,
        triggerState: cmd.triggerState ?? 'unstarted',
        claimedState: cmd.claimedState ?? 'In Progress',
        reviewState: cmd.reviewState ?? 'In Review',
        needsInfoState: cmd.needsInfoState,
        ...(cmd.team !== undefined ? { team: cmd.team } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal,
    });
    return;
  }

  await watchLinear({
    deps: agentDeps,
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

async function buildGithubDeps(cmd: WatchCommand, auth: AgentAuth | undefined, ctx: SandboxContext) {
  const deps = await githubDepsFromEnv(cmd.repoPath, cmd.repoSlug, cmd.provider, cmd.reviewProvider);
  if (auth !== undefined) deps.auth = auth;
  if (ctx.proxyUrl !== undefined && ctx.network !== undefined) {
    deps.proxyUrl = ctx.proxyUrl;
    deps.network = ctx.network;
  }
  if (ctx.llmProxy !== undefined) deps.llmProxy = ctx.llmProxy;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;
  if (cmd.visualProofCmd !== undefined) deps.visualProofCmd = cmd.visualProofCmd;
  return deps;
}

async function watchGithubSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const deps = await buildGithubDeps(cmd, auth, ctx);

  // Loop v1: activated when --spec-label is supplied.
  if (cmd.specLabel !== undefined) {
    if (cmd.agentLabel === undefined || cmd.needsInfoLabel === undefined) {
      throw new Error('--agent-label and --needs-info-label are required with --spec-label for github loop-v1');
    }
    const repoSlug = deps.repoSlug;
    const specDeps: RunSpecGeneratorDeps = {
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new GitHubTaskFetcher(repoSlug),
      ...(ctx.proxyUrl !== undefined && ctx.network !== undefined ? { proxyUrl: ctx.proxyUrl, network: ctx.network } : {}),
      ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
    };
    await watchGithubLoopV1({
      spec: {
        deps: specDeps,
        repoSlug,
        specLabel: cmd.specLabel,
        claimedLabel: cmd.specClaimedLabel ?? GITHUB_SPEC_CLAIMED_LABEL,
        agentLabel: cmd.agentLabel,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      agent: {
        deps,
        label: cmd.agentLabel,
        claimedLabel: cmd.claimedState ?? GITHUB_CLAIMED_LABEL,
        reviewLabel: cmd.reviewState ?? GITHUB_REVIEW_LABEL,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal,
    });
    return;
  }

  if (cmd.label === undefined) throw new Error('--label is required for github watch source');
  await watchGithub({
    deps,
    label: cmd.label,
    claimedLabel: cmd.claimedState ?? GITHUB_CLAIMED_LABEL,
    reviewLabel: cmd.reviewState ?? GITHUB_REVIEW_LABEL,
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    signal,
  });
}

async function watchGithubProjectSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
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

async function watchGitlabSource(
  cmd: WatchCommand,
  auth: AgentAuth | undefined,
  ctx: SandboxContext,
  signal: AbortSignal,
): Promise<void> {
  const deps = await gitlabDepsFromEnv(cmd.repoPath, cmd.project, cmd.provider, cmd.reviewProvider);
  if (auth !== undefined) deps.auth = auth;
  if (ctx.proxyUrl !== undefined && ctx.network !== undefined) {
    deps.proxyUrl = ctx.proxyUrl;
    deps.network = ctx.network;
  }
  if (ctx.llmProxy !== undefined) deps.llmProxy = ctx.llmProxy;
  if (cmd.provider !== undefined) deps.provider = cmd.provider;
  if (cmd.reviewProvider !== undefined) deps.reviewProvider = cmd.reviewProvider;
  if (cmd.providerModel !== undefined) deps.providerModel = cmd.providerModel;
  if (cmd.noSimplify === true) deps.noSimplify = true;
  if (cmd.reviewModel !== undefined) deps.reviewModel = cmd.reviewModel;
  if (cmd.verifyCmd !== undefined) deps.verifyCmd = cmd.verifyCmd;
  if (cmd.visualProofCmd !== undefined) deps.visualProofCmd = cmd.visualProofCmd;

  // Loop v1: activated when --spec-label is supplied.
  if (cmd.specLabel !== undefined) {
    if (cmd.agentLabel === undefined || cmd.needsInfoLabel === undefined) {
      throw new Error('--agent-label and --needs-info-label are required with --spec-label for gitlab loop-v1');
    }
    const specDeps = {
      ...(auth !== undefined ? { auth } : {}),
      repoPath: cmd.repoPath,
      fetcher: new GitLabTaskFetcher(deps.project),
      ...(ctx.proxyUrl !== undefined && ctx.network !== undefined ? { proxyUrl: ctx.proxyUrl, network: ctx.network } : {}),
      ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
      ...(cmd.specModel !== undefined ? { specModel: cmd.specModel } : {}),
    };
    await watchGitlabLoopV1({
      spec: {
        deps: specDeps,
        project: deps.project,
        specLabel: cmd.specLabel,
        claimedLabel: cmd.specClaimedLabel ?? GITLAB_SPEC_CLAIMED_LABEL,
        agentLabel: cmd.agentLabel,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      agent: {
        deps,
        label: cmd.agentLabel,
        claimedLabel: cmd.claimedState ?? GITLAB_CLAIMED_LABEL,
        reviewLabel: cmd.reviewState ?? GITLAB_REVIEW_LABEL,
        needsInfoLabel: cmd.needsInfoLabel,
        ...(cmd.label !== undefined ? { ownerLabel: cmd.label } : {}),
      },
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal,
    });
    return;
  }

  if (cmd.label === undefined) throw new Error('--label is required for gitlab watch source');
  await watchGitlab({
    deps,
    label: cmd.label,
    claimedLabel: cmd.claimedState ?? GITLAB_CLAIMED_LABEL,
    reviewLabel: cmd.reviewState ?? GITLAB_REVIEW_LABEL,
    concurrency: cmd.concurrency,
    intervalMs: cmd.intervalMs,
    once: cmd.once,
    signal,
  });
}
