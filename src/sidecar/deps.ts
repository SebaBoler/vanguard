import { capabilities } from '../api/capabilities.js';
import { createGithubIssue, createGitlabIssue, createLinearIssue } from '../tasks/create.js';
import { beginRun, endRun } from './cancel.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { githubDepsFromEnv, runGithubIssue } from '../runners/github.js';
import { gitlabDepsFromEnv, runGitlabIssue } from '../runners/gitlab.js';
import { runLinearIssue } from '../runners/linear.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { isProviderName } from '../agents/registry.js';
import type { ProviderName } from '../agents/registry.js';
import type { AgentAuth } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { RunEvent } from '../pipeline/events.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from './sidecar.js';

/** Narrow a JSON-supplied provider string to a ProviderName, or throw a clear (loop-reported) error. */
function toProvider(value: string | undefined): ProviderName | undefined {
  if (value === undefined) return undefined;
  if (!isProviderName(value)) throw new Error(`unknown provider: ${value}`);
  return value;
}

/** Env-derived required linear deps (mirrors run.ts `linearDeps`): key + skills dir + repo path. */
function linearExtras(
  repoPath: string,
  auth: AgentAuth | undefined,
): Pick<RunLinearIssueDeps, 'linearKey' | 'skillsDir' | 'repoPath' | 'auth'> {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR (a clone of schpet/linear-cli /skills) for --linear runs.');
  }
  return { linearKey, skillsDir, repoPath, ...(auth !== undefined ? { auth } : {}) };
}

/**
 * Production wiring: build a sandbox context + provider auth from env, then dispatch to the same
 * source runner the CLI uses (mirrors `src/cli/run.ts`), with `onEvent` + the cancel `signal` threaded
 * in. Smoke-verified (needs Docker + creds), not unit-tested. The sidecar child is spawned WITHOUT a
 * project cwd (sidecar.rs runs `sh -c 'exec vanguard __sidecar'`, inheriting the app cwd — unlike
 * spawn.rs's raw-CLI path which sets current_dir), so the target repo must arrive explicitly as
 * `params.repoPath`, per run. Keep this thin — logic belongs in the runners, not here.
 */
export function productionDeps(): SidecarDeps {
  return {
    capabilities,
    // The first WRITE to an external system from the app, and it cannot be undone from inside it.
    // Params are validated at the protocol boundary (validateCreateTask) before we get here.
    createTask: async (params) => {
      const input = {
        title: params.title,
        body: params.body,
        ...(params.labels !== undefined && params.labels.length > 0 ? { labels: params.labels } : {}),
      };
      if (params.source === 'linear') {
        // team is guaranteed by validateCreateTask — an issue in the wrong team is real work in the
        // wrong place, with no undo.
        return createLinearIssue(params.team as string, input);
      }
      if (params.source === 'gitlab') return createGitlabIssue(params.repoPath, input);
      return createGithubIssue(params.repoPath, input);
    },
    createRun: async (params: CreateRunParams, onEvent: (e: RunEvent) => void): Promise<CreateRunResult> => {
      const transport = params.transport ?? 'github';
      const provider = toProvider(params.provider);
      const repoPath = params.repoPath;
      const signal = beginRun();
      const auth = agentAuthFromEnv(provider !== undefined ? { provider } : {});
      const ctx = await startSandboxContext({
        egress: true,
        llmProxy: false,
        ...(auth !== undefined ? { auth } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
      try {
        // The RunOptions the sidecar exposes + the sandbox wiring + the event seam, shared across transports.
        const common = {
          onEvent,
          signal,
          ...(provider !== undefined ? { provider } : {}),
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.baseBranch !== undefined ? { baseBranch: params.baseBranch } : {}),
          // Named-flow dispatch: pass the validated flow key straight through. runSourcedIssue
          // resolves it via FLOWS[flow].build() (Subsystem 2). Any registered FLOWS entry works with
          // no per-flow wiring here; validation happened in sidecar.ts::validateCreateRun.
          ...(params.flow !== undefined ? { flow: params.flow } : {}),
          ...(ctx.proxyUrl !== undefined ? { proxyUrl: ctx.proxyUrl } : {}),
          ...(ctx.network !== undefined ? { network: ctx.network } : {}),
          ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
        };
        if (transport === 'gitlab') {
          const deps = await gitlabDepsFromEnv(repoPath, undefined, provider);
          return await runGitlabIssue(params.issueRef, { ...deps, ...common });
        }
        if (transport === 'linear') {
          return await runLinearIssue(params.issueRef, { ...common, ...linearExtras(repoPath, auth) });
        }
        const deps = await githubDepsFromEnv(repoPath, undefined, provider);
        return await runGithubIssue(params.issueRef, { ...deps, ...common });
      } finally {
        await ctx.destroy();
        endRun();
      }
    },
  };
}
