import { parseArgs } from 'node:util';
import { isProviderName } from '../agents/registry.js';
import type { ProviderName } from '../agents/registry.js';

type WatchSource = 'linear' | 'github' | 'project';

export type Command =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean; abandoned: boolean }
  | {
      kind: 'review-pr';
      prRef: string;
      repoSlug?: string;
      repoPath: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      noSimplify?: boolean;
    }
  | {
      kind: 'watch-prs';
      repoSlug: string;
      repoPath: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      /** Only review PRs opened by this GitHub login (self-review-only when set). */
      author?: string;
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      noSimplify?: boolean;
    }
  | {
      kind: 'doctor-prs';
      repoSlug: string;
      repoPath: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      provider?: ProviderName;
      llmProxy?: boolean;
    }
  | {
      kind: 'doctor';
      source: 'linear' | 'github' | 'project';
      label?: string;
      projectNumber?: number;
      team?: string;
      triggerState?: string;
      claimedState?: string;
      reviewState?: string;
      repoSlug?: string;
      repoPath: string;
      skillsDir?: string;
      provider?: ProviderName;
      reviewProvider?: ProviderName;
      providerModel?: string;
      reviewModel?: string;
      noSimplify?: boolean;
      verifyCmd?: string;
      specModel?: string;
      specLabel?: string;
      agentLabel?: string;
      needsInfoLabel?: string;
      specClaimedLabel?: string;
      specState?: string;
      specStateName?: string;
      agentState?: string;
      needsInfoState?: string;
      specClaimedState?: string;
      llmProxy?: boolean;
    }
  | {
      kind: 'run';
      source: 'linear' | 'github' | 'project';
      id: string;
      parent: boolean;
      gcBefore: boolean;
      egress: boolean;
      /** Hold the provider credential (Anthropic, or z.ai with --provider zai) in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      reuse?: boolean;
      repoPath: string;
      concurrency: number;
      skillsDir?: string;
      repoSlug?: string;
      label?: string;
      provider?: ProviderName;
      reviewProvider?: ProviderName;
      /** Model for the implementer/simplifier stages (default: provider's default). */
      providerModel?: string;
      /** Model for the review stage (default: provider's default). */
      reviewModel?: string;
      noSimplify?: boolean;
      /** Run the implementer stage as N variants via forkAndSelect, keeping the best-scored diff. */
      forkN?: number;
      /** Verification command to run inside the sandbox after the agent finishes (Proof of Work). */
      verifyCmd?: string;
      /** Visual proof command for UI artifacts (overrides VANGUARD_VISUAL_PROOF_CMD). */
      visualProofCmd?: string;
    }
  | {
      kind: 'watch';
      source: 'linear' | 'github' | 'project';
      /** Required for linear/github; optional for project (label-filter on the board). */
      label?: string;
      /** Project number; required when source === 'project'. */
      projectNumber?: number;
      team?: string;
      triggerState?: string;
      claimedState?: string;
      reviewState?: string;
      repoSlug?: string;
      repoPath: string;
      skillsDir?: string;
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      /** Hold the provider credential (Anthropic, or z.ai with --provider zai) in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewProvider?: ProviderName;
      /** Model for the implementer/simplifier stages (default: provider's default). */
      providerModel?: string;
      /** Model for the review stage (default: provider's default). */
      reviewModel?: string;
      noSimplify?: boolean;
      /** Verification command to run inside the sandbox after the agent finishes (Proof of Work). */
      verifyCmd?: string;
      /** Visual proof command for UI artifacts (overrides VANGUARD_VISUAL_PROOF_CMD). */
      visualProofCmd?: string;
      // --- Loop v1 flags ---
      /** (loop-v1) Cheap model for the spec-generation stage. */
      specModel?: string;
      // GitHub loop-v1
      /** (github loop-v1) Label that triggers the spec pass (issues with this label are specced). */
      specLabel?: string;
      /** (github loop-v1) Label the agent pass triggers on (set after spec is generated). */
      agentLabel?: string;
      /** (github loop-v1) Label set when a ticket is too vague (e.g. 'needs info'). */
      needsInfoLabel?: string;
      /**
       * (github loop-v1) Label the spec pass moves a claimed ticket to while speccing
       * (default: 'vanguard:speccing'). Omitted when absent — the default is used.
       */
      specClaimedLabel?: string;
      // Linear loop-v1
      /** (linear loop-v1) State TYPE that triggers the spec pass (e.g. 'triage'). */
      specState?: string;
      /**
       * (linear loop-v1) Display NAME of the spec-trigger state — used to revert the issue on
       * spec-pass failure so the next poll re-picks it (e.g. 'Spec'). Required alongside --spec-state.
       */
      specStateName?: string;
      /** (linear loop-v1) State NAME the spec pass advances to (agent-pass trigger, e.g. 'Todo'). */
      agentState?: string;
      /** (linear loop-v1) State NAME for vague tickets that need more info (e.g. 'Needs Info'). */
      needsInfoState?: string;
      /**
       * (linear loop-v1) State NAME the spec pass moves a claimed ticket to while speccing
       * (default: 'Speccing'). Omitted when absent — the default is used.
       */
      specClaimedState?: string;
    }
  | { kind: 'stats'; repoPath: string; json: boolean }
  | { kind: 'memory'; repoPath: string; limit?: number; json: boolean }
  | { kind: 'help' };

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 6;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LOOP_V1_OWNERSHIP_LABEL = 'vanguard';
const DEFAULT_GITHUB_SPEC_LABEL = 'ready for spec';
const DEFAULT_GITHUB_AGENT_LABEL = 'ready for agent';
const DEFAULT_GITHUB_NEEDS_INFO_LABEL = 'needs info';
const DEFAULT_LINEAR_SPEC_STATE = 'triage';
const DEFAULT_LINEAR_SPEC_STATE_NAME = 'Spec';
const DEFAULT_LINEAR_NEEDS_INFO_STATE = 'Needs Info';
const DEFAULT_PR_REVIEWING_LABEL = 'vanguard:reviewing';
const DEFAULT_PR_REVIEWED_LABEL = 'vanguard:reviewed';

/**
 * Parse argv (without the node/script prefix) into a typed command. Pure: cwd is passed in so this is
 * unit-testable. Unknown options or a missing/unknown command resolve to `help`.
 */
export function parseCli(argv: string[], cwd: string): Command {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        // gc
        repo: { type: 'string' },
        'max-age-hours': { type: 'string' },
        remote: { type: 'string' },
        'dry-run': { type: 'boolean' },
        abandoned: { type: 'boolean' },
        // run
        linear: { type: 'string' },
        github: { type: 'string' },
        'github-pr': { type: 'string' },
        project: { type: 'string' },
        source: { type: 'string' },
        parent: { type: 'boolean' },
        'gc-before': { type: 'boolean' },
        egress: { type: 'boolean' },
        'llm-proxy': { type: 'boolean' },
        reuse: { type: 'boolean' },
        skills: { type: 'string' },
        'github-repo': { type: 'string' },
        label: { type: 'string' },
        'reviewing-label': { type: 'string' },
        'reviewed-label': { type: 'string' },
        author: { type: 'string' },
        concurrency: { type: 'string' },
        // watch
        team: { type: 'string' },
        'trigger-state': { type: 'string' },
        'claimed-state': { type: 'string' },
        'review-state': { type: 'string' },
        interval: { type: 'string' },
        once: { type: 'boolean' },
        'loop-v1': { type: 'boolean' },
        // watch loop-v1
        'spec-label': { type: 'string' },
        'agent-label': { type: 'string' },
        'needs-info-label': { type: 'string' },
        'spec-claimed-label': { type: 'string' },
        'spec-state': { type: 'string' },
        'spec-state-name': { type: 'string' },
        'agent-state': { type: 'string' },
        'needs-info-state': { type: 'string' },
        'spec-claimed-state': { type: 'string' },
        'spec-model': { type: 'string' },
        // provider selection (run + watch)
        provider: { type: 'string' },
        'review-provider': { type: 'string' },
        // model selection per stage (run + watch)
        'provider-model': { type: 'string' },
        'review-model': { type: 'string' },
        // skip the simplifier stage (lean run: implement -> review only)
        'no-simplify': { type: 'boolean' },
        // fork-and-select (run)
        fork: { type: 'string' },
        // proof-of-work verification (run + watch)
        verify: { type: 'string' },
        'visual-proof': { type: 'string' },
        // stats / memory
        json: { type: 'boolean' },
        limit: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    return { kind: 'help' };
  }

  if (values.help === true) return { kind: 'help' };
  const repoPath = typeof values.repo === 'string' ? values.repo : cwd;

  // Provider flags (run + watch). An unknown provider name resolves to help.
  const providerRaw = typeof values.provider === 'string' ? values.provider : undefined;
  const reviewProviderRaw = typeof values['review-provider'] === 'string' ? values['review-provider'] : undefined;
  if (providerRaw !== undefined && !isProviderName(providerRaw)) return { kind: 'help' };
  if (reviewProviderRaw !== undefined && !isProviderName(reviewProviderRaw)) return { kind: 'help' };
  const provider: ProviderName | undefined = providerRaw;
  const reviewProvider: ProviderName | undefined = reviewProviderRaw;

  if (positionals[0] === 'stats') {
    return { kind: 'stats', repoPath, json: values.json === true };
  }

  if (positionals[0] === 'memory') {
    const limit = Number(values.limit);
    return {
      kind: 'memory',
      repoPath,
      ...(Number.isFinite(limit) && limit >= 1 ? { limit: Math.floor(limit) } : {}),
      json: values.json === true,
    };
  }

  if (positionals[0] === 'gc') {
    const hours = Number(values['max-age-hours']);
    const maxAgeMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MAX_AGE_HOURS) * HOUR_MS;
    return {
      kind: 'gc',
      repoPath,
      maxAgeMs,
      dryRun: values['dry-run'] === true,
      abandoned: values.abandoned === true,
      ...(typeof values.remote === 'string' ? { remoteRepo: values.remote } : {}),
    };
  }

  if (positionals[0] === 'review-pr') {
    const prRef = typeof values['github-pr'] === 'string' ? values['github-pr'] : positionals[1];
    if (prRef === undefined) return { kind: 'help' };
    return {
      kind: 'review-pr',
      prRef,
      repoPath,
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(values['no-simplify'] === true ? { noSimplify: true } : {}),
    };
  }

  if (positionals[0] === 'watch-prs') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (repoSlug === undefined || label === undefined) return { kind: 'help' };
    const concurrency = Number(values.concurrency);
    const interval = Number(values.interval);
    return {
      kind: 'watch-prs',
      repoSlug,
      repoPath,
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      egress: values.egress === true,
      ...(typeof values.author === 'string' ? { author: values.author } : {}),
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(values['no-simplify'] === true ? { noSimplify: true } : {}),
    };
  }

  if (positionals[0] === 'doctor-prs') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (repoSlug === undefined || label === undefined) return { kind: 'help' };
    return {
      kind: 'doctor-prs',
      repoSlug,
      repoPath,
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(provider !== undefined ? { provider } : {}),
    };
  }

  if (positionals[0] === 'run') {
    const sources: Array<['linear' | 'github' | 'project', string]> = [];
    if (typeof values.linear === 'string') sources.push(['linear', values.linear]);
    if (typeof values.github === 'string') sources.push(['github', values.github]);
    if (typeof values.project === 'string') sources.push(['project', values.project]);
    // Exactly one source is required.
    const picked = sources[0];
    if (sources.length !== 1 || picked === undefined) return { kind: 'help' };
    const concurrency = Number(values.concurrency);
    const forkN = Number(values.fork);
    return {
      kind: 'run',
      source: picked[0],
      id: picked[1],
      parent: values.parent === true,
      gcBefore: values['gc-before'] === true,
      egress: values.egress === true,
      repoPath,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(Number.isFinite(forkN) && forkN >= 2 ? { forkN: Math.floor(forkN) } : {}),
      ...(values.reuse === true ? { reuse: true } : {}),
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(typeof values.label === 'string' ? { label: values.label } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(reviewProvider !== undefined ? { reviewProvider } : {}),
      ...(typeof values['provider-model'] === 'string' ? { providerModel: values['provider-model'] } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(values['no-simplify'] === true ? { noSimplify: true } : {}),
      ...(typeof values.verify === 'string' ? { verifyCmd: values.verify } : {}),
      ...(typeof values['visual-proof'] === 'string' ? { visualProofCmd: values['visual-proof'] } : {}),
    };
  }

  if (positionals[0] === 'watch' || positionals[0] === 'doctor') {
    const commandKind = positionals[0];
    const source: WatchSource =
      values.source === 'github' || (values.source === undefined && typeof values['github-repo'] === 'string')
        ? 'github'
        : values.source === 'project'
          ? 'project'
          : 'linear';
    // project number is required when source === 'project'
    const projectNumber = typeof values.project === 'string' ? Number(values.project) : undefined;
    if (source === 'project' && (projectNumber === undefined || !Number.isFinite(projectNumber))) return { kind: 'help' };

    let label = typeof values.label === 'string' ? values.label : undefined;
    let specLabel = typeof values['spec-label'] === 'string' ? values['spec-label'] : undefined;
    let agentLabel = typeof values['agent-label'] === 'string' ? values['agent-label'] : undefined;
    let needsInfoLabel = typeof values['needs-info-label'] === 'string' ? values['needs-info-label'] : undefined;
    let specState = typeof values['spec-state'] === 'string' ? values['spec-state'] : undefined;
    let specStateName = typeof values['spec-state-name'] === 'string' ? values['spec-state-name'] : undefined;
    const agentState = typeof values['agent-state'] === 'string' ? values['agent-state'] : undefined;
    let needsInfoState = typeof values['needs-info-state'] === 'string' ? values['needs-info-state'] : undefined;

    const hasGithubLoopFlags =
      specLabel !== undefined ||
      agentLabel !== undefined ||
      needsInfoLabel !== undefined ||
      typeof values['spec-claimed-label'] === 'string';
    const hasLinearLoopFlags =
      specState !== undefined ||
      specStateName !== undefined ||
      agentState !== undefined ||
      needsInfoState !== undefined ||
      typeof values['spec-claimed-state'] === 'string';
    const repoOnlyGithubLoop =
      source === 'github' && label === undefined && !hasGithubLoopFlags && !hasLinearLoopFlags;
    const isLoopV1 = values['loop-v1'] === true || hasGithubLoopFlags || hasLinearLoopFlags || repoOnlyGithubLoop;

    if (isLoopV1 && source === 'github' && hasLinearLoopFlags) return { kind: 'help' };
    if (isLoopV1 && source === 'linear' && hasGithubLoopFlags) return { kind: 'help' };

    if (isLoopV1 && source === 'github') {
      specLabel ??= DEFAULT_GITHUB_SPEC_LABEL;
      agentLabel ??= DEFAULT_GITHUB_AGENT_LABEL;
      needsInfoLabel ??= DEFAULT_GITHUB_NEEDS_INFO_LABEL;
    } else if (isLoopV1 && source === 'linear') {
      label ??= DEFAULT_LOOP_V1_OWNERSHIP_LABEL;
      specState ??= DEFAULT_LINEAR_SPEC_STATE;
      specStateName ??= DEFAULT_LINEAR_SPEC_STATE_NAME;
      needsInfoState ??= DEFAULT_LINEAR_NEEDS_INFO_STATE;
    }

    if (isLoopV1) {
      // Loop v1 validation per source.
      if (source === 'github') {
        if (specLabel === undefined || agentLabel === undefined || needsInfoLabel === undefined) return { kind: 'help' };
        // --label is an optional extra ownership filter in github loop-v1. A repo-scoped shorthand
        // watches the routing labels directly; explicit --label narrows that further when desired.
      } else if (source === 'linear') {
        if (specState === undefined || specStateName === undefined || needsInfoState === undefined) return { kind: 'help' };
        // --label is still the shared ownership label across both passes. Defaults keep the filter,
        // not a status-only scan over the whole Linear workspace.
        if (label === undefined) return { kind: 'help' };
      } else {
        // project source does not support loop-v1
        return { kind: 'help' };
      }
    } else {
      // Existing single-pass validation: label is required for linear/github; optional for project.
      if (source !== 'project' && label === undefined) return { kind: 'help' };
    }

    const interval = Number(values.interval);
    const concurrency = Number(values.concurrency);
    type WatchCommon = Omit<Extract<Command, { kind: 'watch' }>, 'kind' | 'concurrency' | 'intervalMs' | 'once' | 'egress'>;
    const common: WatchCommon = {
      source,
      repoPath,
      ...(label !== undefined ? { label } : {}),
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(typeof values.team === 'string' ? { team: values.team } : {}),
      ...(typeof values['trigger-state'] === 'string' ? { triggerState: values['trigger-state'] } : {}),
      ...(typeof values['claimed-state'] === 'string' ? { claimedState: values['claimed-state'] } : {}),
      ...(typeof values['review-state'] === 'string' ? { reviewState: values['review-state'] } : {}),
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(reviewProvider !== undefined ? { reviewProvider } : {}),
      ...(typeof values['provider-model'] === 'string' ? { providerModel: values['provider-model'] } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(values['no-simplify'] === true ? { noSimplify: true } : {}),
      ...(typeof values.verify === 'string' ? { verifyCmd: values.verify } : {}),
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      // Loop v1 fields (omitted when not supplied, preserving existing behaviour when absent).
      ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
      ...(specLabel !== undefined ? { specLabel } : {}),
      ...(agentLabel !== undefined ? { agentLabel } : {}),
      ...(needsInfoLabel !== undefined ? { needsInfoLabel } : {}),
      ...(typeof values['spec-claimed-label'] === 'string' ? { specClaimedLabel: values['spec-claimed-label'] } : {}),
      ...(specState !== undefined ? { specState } : {}),
      ...(specStateName !== undefined ? { specStateName } : {}),
      ...(agentState !== undefined ? { agentState } : {}),
      ...(needsInfoState !== undefined ? { needsInfoState } : {}),
      ...(typeof values['spec-claimed-state'] === 'string' ? { specClaimedState: values['spec-claimed-state'] } : {}),
    };

    if (commandKind === 'doctor') {
      return { kind: 'doctor', ...common };
    }

    return {
      kind: 'watch',
      ...common,
      ...(typeof values['visual-proof'] === 'string' ? { visualProofCmd: values['visual-proof'] } : {}),
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      egress: values.egress === true,
    };
  }

  return { kind: 'help' };
}

export const USAGE = `vanguard <command>

Commands:
  run    Run an agent on a task and open a draft PR for review.
  watch  Poll Linear or GitHub and run each newly-ready issue automatically (the AFK factory loop).
  doctor Check whether watch can run AFK before any issue is claimed.
  review-pr Review an existing GitHub PR and post a non-blocking Vanguard review comment.
  watch-prs Poll GitHub PRs by label and run the non-blocking Vanguard review loop.
  doctor-prs Check whether watch-prs can run AFK before any PR is claimed.
  stats  Aggregate .vanguard/runs/metrics.jsonl into a cost/token/time rollup (per task, per stage).
  memory Refresh .vanguard/memory/retrospective.md from run artifacts and print it.
  gc     Reap stale sandbox containers, prune worktrees, and (with --remote) delete merged
         remote vanguard/* branches.

  watch options (trigger = state/label + label):
    --source <linear|github|project>  Task source (default: linear)
    --label <name>         Required for linear/github; optional label-filter for project
    --team <KEY>           (linear) limit to a team
    --github-repo <o/r>    (github/project) repo slug (default: detected from origin)
    --project <number>     (project) GitHub Projects v2 project number (required with --source project)
    --trigger-state <x>    Status option name for ready items (project default: "Todo";
                           linear: state type, default "unstarted")
    --claimed-state <x>    Status/label set on claim (project default: "In Progress";
                           linear: state default "In Progress"; github: label "vanguard:running")
    --review-state <x>     Status/label set after a PR opens (project default: "In Review";
                           linear: "In Review"; github: "vanguard:review")
    --interval <seconds>   Poll interval (default: 60); --once does a single pass
    --loop-v1              Use Loop v1 defaults (GitHub labels "ready for spec"/"ready for agent"/
                           "needs info"; Linear ownership label "vanguard", state type "triage",
                           state name "Spec", needs-info state "Needs Info"). For GitHub, a repo-only
                           watch without --label also uses the routing-label defaults.
    --skills <dir> --repo <path> --concurrency <n> --egress   (as for run)
    --provider <claude|codex|cursor|zai>          Provider that runs every stage (default: claude)
    --review-provider <claude|codex|cursor|zai>   Run only the review stage on this provider (cross-provider review)
    --provider-model <m>     Model for the implementer/simplifier stages (default: provider's default)
    --review-model <m>       Model for the review stage (default: provider's default)
    --no-simplify            Skip the simplifier stage (lean: implement -> review only)
    --verify <cmd>           Verification command for Proof of Work (overrides VANGUARD_VERIFY_CMD and auto-detect)
    --visual-proof <cmd>     Visual proof command for UI artifacts (overrides VANGUARD_VISUAL_PROOF_CMD)
    Note (project): Status option names must match the project's Status field exactly.
      Resolve field and option IDs with: gh project field-list <number> --owner <owner> --format json

  watch loop-v1 options (add --loop-v1 or any routing flag to activate; spec pass runs first each tick):
    GitHub loop-v1 (--source github):
      --spec-label <name>        Label that triggers the spec pass (e.g. "ready for spec")
      --agent-label <name>       Label set after spec generation — the agent-pass trigger (e.g. "ready for agent")
      --needs-info-label <name>  Label set when a ticket is too vague for spec or agent (e.g. "needs info")
      --label <name>             OWNERSHIP label: issues must carry this label in addition to the routing label
                                 (e.g. "vanguard"; optional for repo-scoped GitHub watch).
                                 --claimed-state / --review-state still apply to the agent pass.
      --spec-claimed-label <l>   Label the spec pass moves a claimed issue to while speccing
                                 (default: "vanguard:speccing"); use this if your workspace uses a different label.

    Linear loop-v1 (--source linear):
      --spec-state <type>        State TYPE that triggers the spec pass (e.g. "triage")
      --spec-state-name <name>   Display NAME of that state, for failure revert (e.g. "Spec")
      --needs-info-state <name>  State NAME for tickets that are too vague (e.g. "Needs Info")
      --agent-state <name>       State NAME the spec pass advances to (default: "Todo"); the agent
                                 triggers on the TYPE given by --trigger-state (default: "unstarted")
      --spec-claimed-state <s>   State NAME the spec pass moves a claimed issue to while speccing
                                 (default: "Speccing"); use this if your workspace lacks that state.
      (--label, --trigger-state, --claimed-state, --review-state still apply to the agent pass)

    Shared:
      --spec-model <m>           Cheap model for the spec-generation stage (e.g. "haiku")

    Example (GitHub, defaults):
      vanguard watch --source github --github-repo owner/repo

    Example (GitHub, custom labels/model):
      vanguard watch --source github --github-repo owner/repo --label vanguard \\
        --agent-label "ready for agent" --spec-label "ready for spec" \\
        --needs-info-label "needs info" --spec-model haiku

    Example (Linear, defaults):
      vanguard watch --loop-v1 --label vanguard

    Example (Linear, custom state names/model):
      vanguard watch --loop-v1 --label vanguard --spec-state triage --spec-state-name Spec \\
        --needs-info-state "Needs Info" --agent-state Todo --spec-model haiku

  run options (exactly one source):
    --linear <ID>          Run a Linear issue (reads it via the in-sandbox linear-cli skill)
    --github <owner/repo#n> Run a GitHub issue
    --project <number>     Run every issue on a GitHub Projects v2 board (one run + PR each)
    --parent               (Linear) fan the issue's sub-tasks out, one run + PR each
    --label <name>         (project) only run board items with this label
    --gc-before            Reap stale sandboxes + prune worktrees before starting (clean slate)
    --egress               Restrict sandbox egress to an allowlist (anthropic/github/linear/registries)
    --llm-proxy            Hold the Anthropic credential in a trusted sidecar; the sandbox gets only a per-run nonce (implies --egress, Claude + Codex; Cursor stays direct)
    --reuse                Reuse an existing vanguard/<taskId>-* branch/worktree instead of minting a new run id
    --repo <path>          Local git repo to work in (default: cwd)
    --skills <dir>         Skills directory to inject (Linear: the linear-cli skill)
    --github-repo <o/r>    GitHub repo slug (default: detected from origin)
    --concurrency <n>      (parent/project) max tasks at once (default: 2)
    --provider <claude|codex|cursor|zai>          Provider that runs every stage (default: claude)
    --review-provider <claude|codex|cursor|zai>   Run only the review stage on this provider (cross-provider review)
    --provider-model <m>     Model for the implementer/simplifier stages (default: provider's default; zai -> glm-5.2)
    --review-model <m>       Model for the review stage (default: provider's default)
    --no-simplify            Skip the simplifier stage (lean: implement -> review only)
    --fork <n>             Run the implementer as n variants (n>=2) and keep the best-scored diff
    --verify <cmd>         Verification command for Proof of Work (overrides VANGUARD_VERIFY_CMD and auto-detect)
    --visual-proof <cmd>   Visual proof command for UI artifacts (overrides VANGUARD_VISUAL_PROOF_CMD)

  review-pr options:
    <url-or-number>        GitHub PR URL, owner/repo#number, or bare number with --github-repo
    --github-pr <n>        PR number (alternative to positional)
    --github-repo <o/r>    Required for bare PR numbers
    --provider <claude|codex|cursor|zai>          Provider used for the PR review (default: claude)
    --review-model <m>     Model for the PR review
    --egress --llm-proxy --repo <path>         As for run/watch

  watch-prs options:
    --github-repo <o/r>    Required repo slug
    --label <name>         Required trigger label (e.g. "ready for vanguard review")
    --reviewing-label <l>  Label added while a PR is being reviewed (default: "vanguard:reviewing")
    --reviewed-label <l>   Label added after review succeeds (default: "vanguard:reviewed")
    --author <login>       Only review PRs opened by this GitHub login (self-review-only when set)
    --interval <seconds>   Poll interval (default: 60); --once does a single pass
    --concurrency <n>      Max PRs reviewed at once (default: 2)
    --provider <claude|codex|cursor|zai>          Provider used for PR review (default: claude)
    --review-model <m>     Model for the PR review
    --egress --llm-proxy --repo <path>         As for run/watch

    Example:
      vanguard watch-prs --github-repo owner/repo --label "ready for vanguard review"

    Dedupe: successful Vanguard reviews include a hidden head SHA marker; watch-prs skips
      the same PR commit if the trigger label is re-added accidentally.

  doctor-prs options:
    Uses the same repo and label routing flags as watch-prs, but only runs AFK preflight checks and exits.
    Example:
      vanguard doctor-prs --github-repo owner/repo --label "ready for vanguard review"

  gc options:
    --repo <path>          Git repo to prune worktrees / reap branches in (default: cwd)
    --max-age-hours <n>    Only reap resources older than n hours (default: 6)
    --remote <owner/repo>  Also delete merged remote vanguard/* branches (needs gh)
    --dry-run              List what would be reaped without removing anything
    --abandoned            Also delete branches whose PR is closed-unmerged (not just merged)

  stats options:
    --repo <path>          Repo whose .vanguard/runs/metrics.jsonl to read (default: cwd)
    --json                 Emit the aggregated report as JSON instead of tables

  memory options:
    --repo <path>          Repo to read run artifacts from (default: cwd)
    --limit <n>            Max entries to keep in the report (default: 10)
    --json                 Emit the raw report object as JSON instead of markdown

  doctor options:
    Uses the same source/routing flags as watch, but only runs AFK preflight checks and exits.
    Example (GitHub): vanguard doctor --source github --github-repo owner/repo
    Example (Linear): vanguard doctor --loop-v1 --label vanguard --skills ./skills

Env: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (auth); LINEAR_API_KEY (for --linear);
     CODEX_API_KEY / CURSOR_API_KEY (when --provider/--review-provider selects codex/cursor;
       under --llm-proxy the Codex/OpenAI key is held by the sidecar and the sandbox gets a nonce,
       while Cursor's key is still injected directly);
     ZAI_API_KEY (when --provider/--review-provider selects zai; runs the Claude Code CLI against
       z.ai's GLM Coding Plan endpoint, so no Anthropic token is required. Under --llm-proxy the
       z.ai key is held by the sidecar and the sandbox gets a nonce);
     VANGUARD_VERIFY_CMD (verification command for Proof of Work; overridden by --verify);
     VANGUARD_VISUAL_PROOF_CMD (visual proof command for UI artifacts; overridden by --visual-proof).
`;
