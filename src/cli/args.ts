import { parseArgs } from 'node:util';
import { isProviderName } from '../agents/registry.js';
import type { ProviderName } from '../agents/registry.js';

export type Command =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean; abandoned: boolean }
  | {
      kind: 'run';
      source: 'linear' | 'github' | 'project';
      id: string;
      parent: boolean;
      gcBefore: boolean;
      egress: boolean;
      /** Hold the Anthropic credential in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
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
      /** Run the implementer stage as N variants via forkAndSelect, keeping the best-scored diff. */
      forkN?: number;
      /** Verification command to run inside the sandbox after the agent finishes (Proof of Work). */
      verifyCmd?: string;
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
      /** Hold the Anthropic credential in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewProvider?: ProviderName;
      /** Model for the implementer/simplifier stages (default: provider's default). */
      providerModel?: string;
      /** Model for the review stage (default: provider's default). */
      reviewModel?: string;
      /** Verification command to run inside the sandbox after the agent finishes (Proof of Work). */
      verifyCmd?: string;
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
    }
  | { kind: 'stats'; repoPath: string; json: boolean }
  | { kind: 'help' };

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 6;
const DEFAULT_CONCURRENCY = 2;

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
        concurrency: { type: 'string' },
        // watch
        team: { type: 'string' },
        'trigger-state': { type: 'string' },
        'claimed-state': { type: 'string' },
        'review-state': { type: 'string' },
        interval: { type: 'string' },
        once: { type: 'boolean' },
        // watch loop-v1
        'spec-label': { type: 'string' },
        'agent-label': { type: 'string' },
        'needs-info-label': { type: 'string' },
        'spec-state': { type: 'string' },
        'spec-state-name': { type: 'string' },
        'agent-state': { type: 'string' },
        'needs-info-state': { type: 'string' },
        'spec-model': { type: 'string' },
        // provider selection (run + watch)
        provider: { type: 'string' },
        'review-provider': { type: 'string' },
        // model selection per stage (run + watch)
        'provider-model': { type: 'string' },
        'review-model': { type: 'string' },
        // fork-and-select (run)
        fork: { type: 'string' },
        // proof-of-work verification (run + watch)
        verify: { type: 'string' },
        // stats
        json: { type: 'boolean' },
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
      ...(typeof values.verify === 'string' ? { verifyCmd: values.verify } : {}),
    };
  }

  if (positionals[0] === 'watch') {
    const source = values.source === 'github' ? 'github' : values.source === 'project' ? 'project' : 'linear';
    // project number is required when source === 'project'
    const projectNumber = typeof values.project === 'string' ? Number(values.project) : undefined;
    if (source === 'project' && (projectNumber === undefined || !Number.isFinite(projectNumber))) return { kind: 'help' };

    // Detect loop-v1 mode: any spec-trigger flag being present activates it.
    const specLabel = typeof values['spec-label'] === 'string' ? values['spec-label'] : undefined;
    const specState = typeof values['spec-state'] === 'string' ? values['spec-state'] : undefined;
    const isLoopV1 = specLabel !== undefined || specState !== undefined;

    if (isLoopV1) {
      // Loop v1 validation per source.
      if (source === 'github') {
        const agentLabel = typeof values['agent-label'] === 'string' ? values['agent-label'] : undefined;
        const needsInfoLabel = typeof values['needs-info-label'] === 'string' ? values['needs-info-label'] : undefined;
        if (specLabel === undefined || agentLabel === undefined || needsInfoLabel === undefined) return { kind: 'help' };
        // label is optional in github loop-v1 (agent trigger = --agent-label); --label is unused here
      } else if (source === 'linear') {
        const specStateName = typeof values['spec-state-name'] === 'string' ? values['spec-state-name'] : undefined;
        const needsInfoState = typeof values['needs-info-state'] === 'string' ? values['needs-info-state'] : undefined;
        if (specState === undefined || specStateName === undefined || needsInfoState === undefined) return { kind: 'help' };
        // --label is still required for linear loop-v1 (the shared label across both passes)
        if (typeof values.label !== 'string') return { kind: 'help' };
      } else {
        // project source does not support loop-v1
        return { kind: 'help' };
      }
    } else {
      // Existing single-pass validation: label is required for linear/github; optional for project.
      if (source !== 'project' && typeof values.label !== 'string') return { kind: 'help' };
    }

    const interval = Number(values.interval);
    const concurrency = Number(values.concurrency);
    return {
      kind: 'watch',
      source,
      repoPath,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(typeof values.label === 'string' ? { label: values.label } : {}),
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
      ...(typeof values.verify === 'string' ? { verifyCmd: values.verify } : {}),
      // Loop v1 fields (omitted when not supplied, preserving existing behaviour when absent).
      ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
      ...(specLabel !== undefined ? { specLabel } : {}),
      ...(typeof values['agent-label'] === 'string' ? { agentLabel: values['agent-label'] } : {}),
      ...(typeof values['needs-info-label'] === 'string' ? { needsInfoLabel: values['needs-info-label'] } : {}),
      ...(specState !== undefined ? { specState } : {}),
      ...(typeof values['spec-state-name'] === 'string' ? { specStateName: values['spec-state-name'] } : {}),
      ...(typeof values['agent-state'] === 'string' ? { agentState: values['agent-state'] } : {}),
      ...(typeof values['needs-info-state'] === 'string' ? { needsInfoState: values['needs-info-state'] } : {}),
    };
  }

  return { kind: 'help' };
}

export const USAGE = `vanguard <command>

Commands:
  run    Run an agent on a task and open a draft PR for review.
  watch  Poll Linear or GitHub and run each newly-ready issue automatically (the AFK factory loop).
  stats  Aggregate .vanguard/runs/metrics.jsonl into a cost/token/time rollup (per task, per stage).
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
    --skills <dir> --repo <path> --concurrency <n> --egress   (as for run)
    --provider <claude|codex|cursor>          Provider that runs every stage (default: claude)
    --review-provider <claude|codex|cursor>   Run only the review stage on this provider (cross-provider review)
    --provider-model <m>     Model for the implementer/simplifier stages (default: provider's default)
    --review-model <m>       Model for the review stage (default: provider's default)
    --verify <cmd>           Verification command for Proof of Work (overrides VANGUARD_VERIFY_CMD and auto-detect)
    Note (project): Status option names must match the project's Status field exactly.
      Resolve field and option IDs with: gh project field-list <number> --owner <owner> --format json

  watch loop-v1 options (add any spec-trigger flag to activate; spec pass runs first each tick):
    GitHub loop-v1 (--source github; all three flags required together):
      --spec-label <name>       Label that triggers the spec pass (e.g. "ready for spec")
      --agent-label <name>      Label set after spec generation — the agent-pass trigger (e.g. "ready for agent")
      --needs-info-label <name> Label set when a ticket is too vague for spec or agent (e.g. "needs info")
      (--label is not used in github loop-v1; --claimed-state / --review-state still apply to the agent pass)

    Linear loop-v1 (--source linear; all three flags required together plus --label):
      --spec-state <type>       State TYPE that triggers the spec pass (e.g. "triage")
      --spec-state-name <name>  Display NAME of that state, for failure revert (e.g. "Spec")
      --needs-info-state <name> State NAME for tickets that are too vague (e.g. "Needs Info")
      --agent-state <name>      State NAME the spec pass advances to (default: "Todo"); the agent
                                triggers on the TYPE given by --trigger-state (default: "unstarted")
      (--label, --trigger-state, --claimed-state, --review-state still apply to the agent pass)

    Shared:
      --spec-model <m>          Cheap model for the spec-generation stage (e.g. "haiku")

    Example (GitHub):
      vanguard watch --source github --agent-label "ready for agent" \\
        --spec-label "ready for spec" --needs-info-label "needs info" --spec-model haiku

    Example (Linear):
      vanguard watch --label vanguard --spec-state triage --spec-state-name Spec \\
        --needs-info-state "Needs Info" --spec-model haiku

  run options (exactly one source):
    --linear <ID>          Run a Linear issue (reads it via the in-sandbox linear-cli skill)
    --github <owner/repo#n> Run a GitHub issue
    --project <number>     Run every issue on a GitHub Projects v2 board (one run + PR each)
    --parent               (Linear) fan the issue's sub-tasks out, one run + PR each
    --label <name>         (project) only run board items with this label
    --gc-before            Reap stale sandboxes + prune worktrees before starting (clean slate)
    --egress               Restrict sandbox egress to an allowlist (anthropic/github/linear/registries)
    --llm-proxy            Hold the Anthropic credential in a trusted sidecar; the sandbox gets only a per-run nonce (implies --egress, Claude only)
    --reuse                Reuse an existing vanguard/<taskId>-* branch/worktree instead of minting a new run id
    --repo <path>          Local git repo to work in (default: cwd)
    --skills <dir>         Skills directory to inject (Linear: the linear-cli skill)
    --github-repo <o/r>    GitHub repo slug (default: detected from origin)
    --concurrency <n>      (parent/project) max tasks at once (default: 2)
    --provider <claude|codex|cursor>          Provider that runs every stage (default: claude)
    --review-provider <claude|codex|cursor>   Run only the review stage on this provider (cross-provider review)
    --provider-model <m>     Model for the implementer/simplifier stages (default: provider's default)
    --review-model <m>       Model for the review stage (default: provider's default)
    --fork <n>             Run the implementer as n variants (n>=2) and keep the best-scored diff
    --verify <cmd>         Verification command for Proof of Work (overrides VANGUARD_VERIFY_CMD and auto-detect)

  gc options:
    --repo <path>          Git repo to prune worktrees / reap branches in (default: cwd)
    --max-age-hours <n>    Only reap resources older than n hours (default: 6)
    --remote <owner/repo>  Also delete merged remote vanguard/* branches (needs gh)
    --dry-run              List what would be reaped without removing anything
    --abandoned            Also delete branches whose PR is closed-unmerged (not just merged)

  stats options:
    --repo <path>          Repo whose .vanguard/runs/metrics.jsonl to read (default: cwd)
    --json                 Emit the aggregated report as JSON instead of tables

Env: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (auth); LINEAR_API_KEY (for --linear);
     CODEX_API_KEY / CURSOR_API_KEY (when --provider/--review-provider selects codex/cursor);
     VANGUARD_VERIFY_CMD (verification command for Proof of Work; overridden by --verify).
`;
