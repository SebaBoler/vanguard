import { execa } from 'execa';
import { taskToVariables } from '../tasks/fetcher.js';
import { DockerSandboxProvider } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { runStages, techSpecStage } from '../pipeline/pipeline.js';
import { authSecrets } from '../agents/auth.js';
import { persistRunRecord } from '../core/run-record.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { extractTag, extractTagLenient } from '../structured/extract.js';
import { VanguardError } from '../core/errors.js';
import { SPEC_TAG } from '../tasks/triage.js';
import { SPEC_MANIFEST_TAG } from '../pipeline/conformance-gate.js';
import type { Task, TaskFetcher } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, ProviderProxySecrets } from '../agents/registry.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider } from '../agents/provider.js';
import type { RunDeps } from '../core/vanguard.js';
import { createLogger, type VanguardLogger } from '../core/logger.js';

/**
 * Everything needed to research one task and produce its technical specification. Mirrors the subset
 * of RunGithubIssueDeps / RunLinearIssueDeps the spec pass actually uses: no PR is ever opened, so the
 * repo slug / verification / fork / review-model options are intentionally absent.
 */
export interface RunSpecGeneratorDeps extends ProviderChoice {
  auth?: AgentAuth;
  /** Local repo path: where the worktree is cut and where the run record is persisted. */
  repoPath: string;
  /** Source of the task being specced. Injected so the spec pass is testable without a live source. */
  fetcher: TaskFetcher;
  /** Extra secrets to forward into the sandbox (e.g. LINEAR_API_KEY for the Linear source). */
  sandboxSecrets?: Record<string, string>;
  /** When set, route the sandbox's egress through this proxy URL (HTTPS_PROXY). */
  proxyUrl?: string;
  /** When set, join the sandbox to this docker network (the hard egress enclave). */
  network?: string;
  /**
   * When set, route Claude through a trusted LLM-proxy sidecar: the real Anthropic credential stays
   * out of the sandbox, which authenticates with the per-run nonce against the proxy host instead.
   */
  llmProxy?: LlmProxyDep;
  /** Model for the tech-spec stage (default: techSpecStage's own default). */
  specModel?: string;
  /** Branch the research worktree is cut from — the baseline Fable specs against (default: main). */
  baseBranch?: string;
  logger?: VanguardLogger;
  signal?: AbortSignal;
  /**
   * Sandbox factory, injected for tests so the spec pass can run against a fake sandbox. Defaults to a
   * real Docker sandbox built exactly like runGithubIssue's.
   */
  sandboxFactory?: (secrets: Record<string, string>) => IsolatedSandboxProvider;
  /** Agent provider override, injected for tests. Defaults to selectAgents(deps).agent. */
  agent?: AgentProvider;
  /** prepareContext deps (worktrees/skills), injected for tests. */
  contextDeps?: RunDeps;
}

/** Build the default Docker sandbox for the spec pass — same shape as the issue runners. */
function defaultSandboxFactory(
  deps: RunSpecGeneratorDeps,
  secrets: Record<string, string>,
  openaiProxy: LlmProxyDep | undefined,
  injectAnthropicAuth: boolean,
): IsolatedSandboxProvider {
  const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, openaiProxy);
  return new DockerSandboxProvider({
    image: 'vanguard-sandbox:latest',
    // In llm-proxy mode the real Claude secret stays in the sidecar — the sandbox gets only the nonce.
    secrets: {
      ...(deps.llmProxy === undefined && deps.auth !== undefined && injectAnthropicAuth ? authSecrets(deps.auth) : {}),
      ...secrets,
    },
    ...sandboxResourceLimits(),
    ...(env !== undefined ? { env } : {}),
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
}

/**
 * Resolve the ref the spec's research worktree is cut from, fetching it from `origin` first so the
 * spec is written against the branch as it exists on the remote — not a stale, or entirely absent,
 * local copy (the very reason a spec diverges from a branch someone else is actively pushing to).
 * Best-effort: with no `origin`, offline, or a branch the remote doesn't carry, it logs and returns
 * the local `base` so the spec pass still runs.
 */
export async function resolveSpecBaseRef(repoPath: string, base: string, logger?: VanguardLogger): Promise<string> {
  // Default a logger so the resolved baseline is ALWAYS announced — the one positive signal that tells
  // you which ref the spec was actually written against (vs a silent fallback to a stale local copy).
  const log = logger ?? createLogger();
  try {
    await execa('git', ['fetch', 'origin', base], { cwd: repoPath });
  } catch (err) {
    log.warn({ err, base }, `spec: git fetch origin ${base} failed — researching against local ${base} (may be stale)`);
    return base;
  }
  try {
    // Cut from the freshly-fetched remote-tracking ref so the worktree reflects origin, not local.
    const { stdout: sha } = await execa('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { cwd: repoPath });
    log.info({ base, sha }, `spec: researching against origin/${base} @ ${sha.slice(0, 7)}`);
    return `origin/${base}`;
  } catch {
    log.warn({ base }, `spec: origin has no ${base} — researching against local ${base}`);
    return base;
  }
}

/**
 * Run the read-only SPEC pass for one task: fetch it, research the codebase in an isolated sandbox via
 * the tech-spec stage, and return the generated technical specification markdown. This is the front
 * half of Loop v1 — it NEVER commits, pushes, or opens a PR (no publishForReview / commitStage call
 * exists in this file by construction), it only produces a spec the caller posts back onto the ticket.
 *
 * The sandbox lifecycle mirrors the issue runners exactly: prepareContext provisions the worktree +
 * sandbox, the stage runs read-only (techSpecStage sets copyBack:false), and disposeContext tears it
 * down in a finally. The run is persisted with the 'spec' label so the AFK fleet leaves a trace.
 *
 * @throws VanguardError when the agent does not emit a <tech_spec> block (so the caller's onFailure runs).
 */
export async function runSpecGenerator(id: string, deps: RunSpecGeneratorDeps): Promise<string> {
  const task: Task = await deps.fetcher.fetch(id);

  // When the agent is injected (tests), use it directly and skip selectAgents (which checks API keys).
  // When it is not, run selectAgents to pick the provider and collect its secrets.
  let agent = deps.agent;
  let secrets: Record<string, string> = deps.sandboxSecrets ?? {};
  // Proxied provider keys (held by sidecars in proxy mode); only set when selectAgents runs (not the
  // injected-agent test path), so injected runs never start a real sidecar.
  let proxySecrets: ProviderProxySecrets = {};
  // Whether the runner should layer Anthropic authSecrets into the sandbox. Defaults to true (the
  // injected-agent test path mimics a Claude run); set from selectAgents when it runs.
  let injectAnthropicAuth = true;
  if (agent === undefined) {
    const selected = selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });
    agent = selected.agent;
    secrets = { ...selected.secrets, ...secrets };
    proxySecrets = selected.proxySecrets;
    injectAnthropicAuth = selected.injectAnthropicAuth;
  }
  if (agent === undefined) throw new VanguardError('No agent available for the spec pass');

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox. Created
  // before prepareContext so the finally below tears them down even if context provisioning throws.
  const providerProxies = await startProviderProxies({
    proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const sandbox = (deps.sandboxFactory ?? ((s) => defaultSandboxFactory(deps, s, providerProxies.openai, injectAnthropicAuth)))(secrets);

    // Fetch the base up front so the spec is researched against origin's view of the branch, not a
    // stale local checkout (see resolveSpecBaseRef). Always set — defaults to a fetched `main`.
    const baseBranch = await resolveSpecBaseRef(deps.repoPath, deps.baseBranch ?? 'main', deps.logger);
    const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath);
    const ctx = await prepareContext(
      {
        taskId: `spec-${task.id.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`,
        localRepoPath: deps.repoPath,
        sandbox,
        agentName: agent.name,
        baseBranch,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      },
      deps.contextDeps ?? {},
    );
    try {
      // haiku keeps the spec pass cheap on Claude; z.ai doesn't serve haiku, so let ZaiProvider pick its
      // own default (glm). An explicit --spec-model always wins.
      const specModel = deps.specModel ?? (deps.provider === 'zai' ? undefined : 'haiku');
      const outcomes = await runStages(ctx, techSpecStage(specModel !== undefined ? { model: specModel } : {}), {
        agent,
        variables: { ...taskToVariables(task), RETROSPECTIVE_MEMORY: retrospectiveMemory },
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      deps.logger?.info({ taskId: ctx.taskId }, summarizeOutcomes(outcomes));

      const specOutcome = outcomes[outcomes.length - 1];
      if (specOutcome === undefined) {
        throw new VanguardError(`Tech-spec stage produced no <${SPEC_TAG}> block for ${task.id}`);
      }
      // Lenient extraction recovers a spec whose closing tag was lost to a truncated stream (common
      // through a corp MITM proxy). A genuinely empty result yields undefined below.
      const extracted = extractTagLenient(specOutcome.result.finalText, SPEC_TAG);
      if (extracted === undefined) {
        // Persist the failed run BEFORE throwing so its transcript/cost survive for diagnosis instead
        // of being discarded (best-effort: a persist failure must not mask the real error).
        await persistRunRecord(deps.repoPath, specOutcome.result, { label: 'spec' }).catch(() => {});
        throw new VanguardError(
          `Tech-spec stage produced no <${SPEC_TAG}> block for ${task.id} ` +
            `(exitReason: ${specOutcome.result.exitReason}, turns: ${specOutcome.result.turns}). Re-run the spec.`,
        );
      }
      if (extracted.salvaged) {
        deps.logger?.warn(
          { taskId: ctx.taskId, exitReason: specOutcome.result.exitReason, turns: specOutcome.result.turns },
          `salvaged a truncated <${SPEC_TAG}> block (closing tag missing) — the spec tail may be clipped`,
        );
      }
      const spec = extracted.text;

      // techSpecStage always returns exactly one stage; persist that single outcome.
      await persistRunRecord(deps.repoPath, specOutcome.result, { label: 'spec' });

      // Carry the manifest verbatim inside the returned spec so watch.ts's <tech_spec> wrapper still
      // lands it in the posted comment — parseSpecManifest regexes for the tag anywhere in the comment
      // text, so nesting inside <tech_spec> doesn't stop the conformance gate from reading it.
      const manifest = extractTag(specOutcome.result.finalText, SPEC_MANIFEST_TAG);
      if (manifest === undefined || manifest === '') return spec;
      return `${spec}\n\n<${SPEC_MANIFEST_TAG}>\n${manifest}\n</${SPEC_MANIFEST_TAG}>`;
    } finally {
      await refreshRetrospectiveMemory(deps.repoPath).catch((err: unknown) => {
        deps.logger?.warn({ err }, 'retrospective memory refresh failed (non-fatal)');
      });
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
