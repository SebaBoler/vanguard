import { capabilities } from '../api/capabilities.js';
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
 * source runner the CLI uses (mirrors `src/cli/run.ts`), with `onEvent` threaded in — the only field
 * this bridge adds. Smoke-verified (needs Docker + creds), not unit-tested. The child's cwd is the
 * project dir (spawned per `spawn.rs`), so `repoPath = process.cwd()`. Keep this thin — logic belongs
 * in the runners, not here.
 */
export function productionDeps(): SidecarDeps {
  return {
    capabilities,
    createRun: async (params: CreateRunParams, onEvent: (e: RunEvent) => void): Promise<CreateRunResult> => {
      const transport = params.transport ?? 'github';
      const provider = toProvider(params.provider);
      const repoPath = process.cwd();
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
          ...(provider !== undefined ? { provider } : {}),
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.baseBranch !== undefined ? { baseBranch: params.baseBranch } : {}),
          ...(params.flow === 'plan' ? { plan: true } : {}),
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
      }
    },
  };
}
