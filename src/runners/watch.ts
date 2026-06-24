import { LinearCliTaskFetcher, setLinearState, commentLinearIssue } from '../tasks/linear-cli.js';
import { GitHubTaskFetcher, editGithubLabels, commentGithubIssue, defaultGhRunner } from '../tasks/github.js';
import { GitLabTaskFetcher, editGitlabLabels, commentGitlabIssue, defaultGlabRunner } from '../tasks/gitlab.js';
import { runLinearIssue } from './linear.js';
import { runGithubIssue } from './github.js';
import { runGitlabIssue } from './gitlab.js';
import { runSpecGenerator } from './spec.js';
import { assessTaskReadiness, isVanguardSpec, SPEC_TAG } from '../tasks/triage.js';
import { fanOut } from '../pipeline/fan-out.js';
import type { Task } from '../tasks/fetcher.js';
import type { RunLinearIssueDeps } from './linear.js';
import type { RunGithubIssueDeps } from './github.js';
import type { RunGitlabIssueDeps } from './gitlab.js';
import type { RunSpecGeneratorDeps } from './spec.js';
import type { LinearCliRunner } from '../tasks/linear-cli.js';
import type { GhRunner } from '../tasks/github.js';
import type { GlabRunner } from '../tasks/gitlab.js';

/** Injectable spec generator (the real one boots a sandbox; tests inject a fake). */
export type GenerateSpec = (id: string, deps: RunSpecGeneratorDeps) => Promise<string>;

/** Clarification comment posted when triage flags a ticket as too vague to proceed. */
function clarifyMessage(mode: 'spec' | 'agent'): string {
  return mode === 'spec'
    ? 'Vanguard could not start: this ticket is too vague to spec. Add a clear description (what and why) and re-trigger.'
    : 'Vanguard could not start: this ticket lacks acceptance criteria or a spec. Add testable acceptance criteria (or a spec comment) and re-trigger.';
}

/** Wrap a generated spec so the agent pass and triage recognise it as a spec comment. */
function specComment(spec: string): string {
  return `Vanguard tech spec:\n\n<${SPEC_TAG}>\n${spec}\n</${SPEC_TAG}>`;
}

export interface WatchPrimitives {
  /** List issues currently ready to run (trigger state + label). */
  listReady: () => Promise<Array<{ id: string }>>;
  /** Claim an issue so a later poll won't pick it again (e.g. move it out of the trigger state). */
  claim: (id: string) => Promise<void>;
  runOne: (id: string) => Promise<{ prUrl?: string }>;
  /** Mark an issue as in review (a PR opened). */
  review: (id: string) => Promise<void>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

export interface WatchTick {
  opened: string[];
  noChange: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
}

type Kind = 'opened' | 'noChange' | 'failed' | 'skipped';

interface WatchLogOptions {
  log?: (msg: string) => void;
  phase?: string;
}

interface WatchOnceOptions extends WatchLogOptions {
  concurrency?: number;
}

function operatorLog(opts: WatchLogOptions, msg: string): void {
  opts.log?.(msg);
}

/**
 * One poll: claim each ready issue (skipping any that can't be claimed), run it, then move it to
 * review when a PR opens or report the failure. Pure orchestration over injected primitives, so the
 * claim-before-run ordering and dedup are unit-testable without Linear.
 */
export async function watchOnce(primitives: WatchPrimitives, opts: WatchOnceOptions = {}): Promise<WatchTick> {
  const ready = await primitives.listReady();
  const phase = opts.phase ?? 'watch';
  operatorLog(opts, `${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: Kind }> => {
      try {
        await primitives.claim(item.id);
        operatorLog(opts, `${phase} ${item.id}: claim -> running`);
      } catch {
        operatorLog(opts, `${phase} ${item.id}: skipped -> already claimed`);
        return { id: item.id, kind: 'skipped' };
      }
      try {
        const { prUrl } = await primitives.runOne(item.id);
        if (prUrl === undefined) {
          operatorLog(opts, `${phase} ${item.id}: no change -> idle`);
          return { id: item.id, kind: 'noChange' };
        }
        await primitives.review(item.id);
        operatorLog(opts, `${phase} ${item.id}: pr opened -> review`);
        return { id: item.id, kind: 'opened' };
      } catch (error) {
        await primitives.onFailure(item.id, error);
        operatorLog(opts, `${phase} ${item.id}: failed -> failure noted`);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: Kind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { opened: ids('opened'), noChange: ids('noChange'), failed: ids('failed'), skipped: ids('skipped') };
}

export interface SpecWatchPrimitives {
  listReady: () => Promise<Array<{ id: string }>>;
  claim: (id: string) => Promise<void>;
  /**
   * Triage + (spec-gen+comment+advance) or (clarify+needs-info). Returns the outcome.
   * At-least-once: the spec comment may be posted more than once if the advance step fails, but the
   * isSpecComment guard skips regeneration on retry so a re-run is cheap and posts no duplicate spec.
   */
  runSpec: (id: string) => Promise<'advanced' | 'needs_info'>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

export interface SpecTick {
  /** Triaged ready: spec generated, posted, and advanced to the agent trigger. */
  advanced: string[];
  /** Triaged vague: a clarification was requested and the issue moved to needs-info. */
  needsInfo: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
}

type SpecKind = 'advanced' | 'needsInfo' | 'failed' | 'skipped';

/**
 * One SPEC poll: claim each ready issue (skipping any that can't be claimed), triage it, then either
 * generate+post a tech spec and advance it to the agent trigger, or request clarification and move it
 * to needs-info. Mirrors watchOnce structurally (claim-before-run, fan-out, failure isolation) but
 * with honest spec semantics instead of PR semantics — it never opens a PR.
 */
export async function specOnce(primitives: SpecWatchPrimitives, opts: WatchOnceOptions = {}): Promise<SpecTick> {
  const ready = await primitives.listReady();
  const phase = opts.phase ?? 'spec';
  operatorLog(opts, `${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: SpecKind }> => {
      try {
        await primitives.claim(item.id);
        operatorLog(opts, `${phase} ${item.id}: claim -> triage`);
      } catch {
        operatorLog(opts, `${phase} ${item.id}: skipped -> already claimed`);
        return { id: item.id, kind: 'skipped' };
      }
      try {
        const outcome = await primitives.runSpec(item.id);
        operatorLog(
          opts,
          outcome === 'advanced'
            ? `${phase} ${item.id}: advanced -> next poll agent`
            : `${phase} ${item.id}: needs info -> waiting human`,
        );
        return { id: item.id, kind: outcome === 'advanced' ? 'advanced' : 'needsInfo' };
      } catch (error) {
        await primitives.onFailure(item.id, error);
        operatorLog(opts, `${phase} ${item.id}: failed -> retry later`);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: SpecKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { advanced: ids('advanced'), needsInfo: ids('needsInfo'), failed: ids('failed'), skipped: ids('skipped') };
}

export interface WatchLinearOptions {
  deps: RunLinearIssueDeps;
  label: string;
  /** Linear state TYPE to poll (triage/backlog/unstarted/started/...); default 'unstarted' (Todo-like). */
  triggerState?: string;
  /** State NAME to move an issue to on claim, e.g. 'In Progress'. */
  claimedState: string;
  /** State NAME after a PR opens, e.g. 'In Review'. */
  reviewState: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + moved to this state and NO implement budget is spent (returns
   * no PR). Absent => behaviour is unchanged (no triage, straight to runLinearIssue).
   */
  needsInfoState?: string;
  team?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  linear?: LinearCliRunner;
}

/** Build the real Linear-backed primitives: state+label trigger, claim and review via state changes. */
export function linearWatchPrimitives(opts: WatchLinearOptions): WatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
  });
  const trigger = opts.triggerState ?? 'unstarted';
  const needsInfoState = opts.needsInfoState;
  return {
    listReady: () => fetcher.list({ labels: [opts.label], state: trigger }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runOne:
      needsInfoState === undefined
        ? (id) => runLinearIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runLinearIssue(i, opts.deps), {
              comment: (body) => commentLinearIssue(id, body, opts.linear),
              toNeedsInfo: () => setLinearState(id, needsInfoState, opts.linear),
            }),
    review: (id) => setLinearState(id, opts.reviewState, opts.linear),
    onFailure: (id, error) => commentLinearIssue(id, `Vanguard run failed: ${String(error)}`, opts.linear),
  };
}

export interface WatchLinearSpecOptions {
  /** Deps for the spec generator (no PR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  label: string;
  /** Linear state TYPE to poll for spec-ready issues (e.g. 'triage'). */
  specTriggerState?: string;
  /**
   * The display NAME of the same state as `specTriggerState` (which is a TYPE). Needed because
   * `issue update --state` takes a state NAME, not a type — this is the name the issue is reverted to
   * on failure so a later poll re-picks it. E.g. specTriggerState: 'triage', specTriggerStateName: 'Spec'.
   */
  specTriggerStateName: string;
  /** State NAME to move an issue to on claim, e.g. 'Speccing'. */
  claimedState: string;
  /** State NAME after a spec is generated — the agent-pass trigger, e.g. 'Todo'. */
  agentState: string;
  /** State NAME when triage flags the ticket as too vague, e.g. 'Needs Info'. */
  needsInfoState: string;
  team?: string;
  linear?: LinearCliRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/** Actions injected per-source into runSpecCore. */
interface RunSpecCoreActions {
  postComment: (body: string) => Promise<void>;
  advance: () => Promise<void>;
  toNeedsInfo: () => Promise<void>;
}

/**
 * Shared 3-branch spec-run logic used by both Linear and GitHub spec primitives.
 *
 * Branch (a) idempotent retry — already Vanguard-specced: advance without regenerating.
 * Branch (b) triage says needs_info: post clarification comment then move to needs-info.
 * Branch (c) normal path: generate spec, post it, then advance.
 *
 * Call order is preserved: postComment BEFORE advance/toNeedsInfo.
 */
async function runSpecCore(
  task: Task,
  id: string,
  deps: RunSpecGeneratorDeps,
  generate: GenerateSpec,
  actions: RunSpecCoreActions,
): Promise<'advanced' | 'needs_info'> {
  // (a) Idempotent retry: if a Vanguard-generated spec is already posted skip regeneration and just
  // advance — cheap, no duplicate spec comment / wasted sandbox+LLM.
  if (task.comments.some((c) => isVanguardSpec(c))) {
    await actions.advance();
    return 'advanced';
  }

  // (b) Triage gate: description too vague to spec.
  if (assessTaskReadiness(task, 'spec') === 'needs_info') {
    await actions.postComment(clarifyMessage('spec'));
    await actions.toNeedsInfo();
    return 'needs_info';
  }

  // (c) Normal path: generate, post, advance.
  const spec = await generate(id, deps);
  await actions.postComment(specComment(spec));
  await actions.advance();
  return 'advanced';
}

/**
 * Shared agent-pass triage gate used by both Linear and GitHub issue watch primitives.
 *
 * When the needs-info option is set: fetch the task, run assessTaskReadiness in 'agent' mode,
 * and if vague post the clarification comment and move to needs-info (returns {} so watchOnce
 * counts this as noChange — no implement budget spent). Otherwise delegate to the real runner.
 *
 * When the needs-info option is absent: delegate directly without fetching (behaviour unchanged).
 */
async function triageAgentRun(
  id: string,
  fetcher: { fetch: (id: string) => Promise<Task> },
  runner: (id: string) => Promise<{ prUrl?: string }>,
  action: {
    comment: (body: string) => Promise<void>;
    toNeedsInfo: () => Promise<void>;
  },
): Promise<{ prUrl?: string }> {
  const task = await fetcher.fetch(id);
  if (assessTaskReadiness(task, 'agent') === 'needs_info') {
    await action.comment(clarifyMessage('agent'));
    await action.toNeedsInfo();
    return {}; // no PR -> watchOnce categorises as noChange, no implement budget spent
  }
  return runner(id);
}

/**
 * Linear SPEC primitives: poll a state+label trigger, triage each issue, then either generate+post a
 * tech spec and advance the issue to the agent state, or request clarification and move it to
 * needs-info. On failure the issue is reverted to its spec-trigger state so a later poll retries it.
 */
export function linearSpecPrimitives(opts: WatchLinearSpecOptions): SpecWatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
  });
  const trigger = opts.specTriggerState ?? 'triage';
  const generate = opts.generateSpec ?? runSpecGenerator;
  return {
    listReady: () => fetcher.list({ labels: [opts.label], state: trigger }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentLinearIssue(id, body, opts.linear),
        advance: () => setLinearState(id, opts.agentState, opts.linear),
        toNeedsInfo: () => setLinearState(id, opts.needsInfoState, opts.linear),
      });
    },
    onFailure: async (id, error) => {
      await commentLinearIssue(id, `Vanguard spec failed: ${String(error)}`, opts.linear);
      await setLinearState(id, opts.specTriggerStateName, opts.linear);
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface LoopControls {
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Poll on an interval, running each newly-ready item. Stops on signal or after one pass (once). */
async function runWatchLoop(primitives: WatchPrimitives, opts: LoopControls, log: (msg: string) => void): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchOnce(primitives, {
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      log,
      phase: 'watch',
    });
    log(`watch: ${tick.opened.length} PR(s), ${tick.noChange.length} no-change, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

/** Poll Linear and run each newly-ready issue. */
export async function watchLinear(opts: WatchLinearOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(linearWatchPrimitives(opts), opts, log);
}

/**
 * Loop-v1 poll: run the SPEC pass (specOnce over specPrimitives) then the AGENT pass (watchOnce over
 * agentPrimitives) once per tick. Continuous loops defer freshly-specced tickets to the next poll,
 * giving a human a window to intervene before the agent runs. One-shot runs carry freshly-specced
 * tickets into the same invocation, which avoids relying on GitHub's eventually consistent label
 * search in GitHub Actions.
 * Pure orchestration over injected primitives; the per-source wrappers build the primitives.
 */
export async function runLoopV1(
  specPrimitives: SpecWatchPrimitives,
  agentPrimitives: WatchPrimitives,
  opts: LoopControls,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const concurrency = opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {};
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const spec = await specOnce(specPrimitives, { ...concurrency, log, phase: 'spec' });
    log(`spec: ${spec.advanced.length} advanced, ${spec.needsInfo.length} needs-info, ${spec.failed.length} failed, ${spec.skipped.length} skipped.`);
    // GitHub's label index is eventually consistent: a label written by the spec pass may not
    // appear in listReady for several seconds. In --once mode carry just-advanced IDs directly
    // into the agent ready-set so spec→build completes in one invocation, deduping against what
    // the index already returned. In continuous mode exclude them — the next poll is the
    // human-intervention window before the agent runs.
    const listed = await agentPrimitives.listReady();
    const advancedSet = new Set(spec.advanced);
    const listedIds = new Set(listed.map((item) => item.id));
    const agentReady =
      opts.once === true
        ? [...spec.advanced.filter((id) => !listedIds.has(id)).map((id) => ({ id })), ...listed]
        : listed.filter((item) => !advancedSet.has(item.id));
    const agentThisTick: WatchPrimitives = {
      ...agentPrimitives,
      listReady: async () => agentReady,
    };
    const agent = await watchOnce(agentThisTick, { ...concurrency, log, phase: 'watch' });
    log(`watch: ${agent.opened.length} PR(s), ${agent.noChange.length} no-change, ${agent.failed.length} failed, ${agent.skipped.length} skipped.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

export interface WatchLinearLoopV1Options {
  /** SPEC-pass options (state+label trigger, spec-gen, advance to the agent state). */
  spec: WatchLinearSpecOptions;
  /** AGENT-pass options. Supply needsInfoState to gate vague tickets out of the implement budget. */
  agent: WatchLinearOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Loop v1 over Linear: each poll runs the spec pass then the agent pass. */
export async function watchLinearLoopV1(opts: WatchLinearLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(linearSpecPrimitives(opts.spec), linearWatchPrimitives(opts.agent), opts, log);
}

export interface WatchGithubOptions {
  deps: RunGithubIssueDeps;
  /** Trigger label: open issues with this label are picked. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label` to be listed
   * as ready. Absent => only `label` is required (existing single-loop behaviour unchanged).
   * Used in loop-v1 so the `--label` (e.g. 'vanguard') ownership requirement is enforced even though
   * the routing labels (agent/spec trigger) already filter the query.
   */
  ownerLabel?: string;
  /** Label added on claim (and the trigger label removed) so re-polls skip it, e.g. 'vanguard:running'. */
  claimedLabel: string;
  /** Label added after a PR opens, e.g. 'vanguard:needs-human-review'. */
  reviewLabel: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + swapped to this label (claimed removed) and NO implement budget
   * is spent (returns no PR). Absent => behaviour is unchanged (no triage, straight to runGithubIssue).
   */
  needsInfoLabel?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/** GitHub-issue primitives: trigger by label, claim/review by swapping labels (issues have no states). */
export function githubIssueWatchPrimitives(opts: WatchGithubOptions): WatchPrimitives {
  const repo = opts.deps.repoSlug;
  const fetcher = new GitHubTaskFetcher(repo, opts.gh);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  return {
    listReady: async () => (await fetcher.list({ labels: agentLabels })).map((task) => ({ id: task.id })),
    claim: (id) => editGithubLabels(repo, id, { remove: [opts.label], add: [opts.claimedLabel] }, opts.gh),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGithubIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGithubIssue(i, opts.deps), {
              comment: (body) => commentGithubIssue(repo, id, body, opts.gh),
              toNeedsInfo: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, opts.gh),
            }),
    review: (id) => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, opts.gh),
    onFailure: (id, error) => commentGithubIssue(repo, id, `Vanguard run failed: ${String(error)}`, opts.gh),
  };
}

export interface WatchGithubSpecOptions {
  /** Deps for the spec generator (no PR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  /** owner/repo the issues live in (the spec deps' fetcher is used to read them). */
  repoSlug: string;
  /** Trigger label: open issues with this label are picked for speccing. */
  specLabel: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `specLabel` to be
   * listed as ready for the spec pass. Absent => only `specLabel` is required (existing behaviour).
   * Used in loop-v1 so the `--label` (e.g. 'vanguard') ownership requirement is enforced on top of
   * the spec-trigger routing label. Claim/advance/needs-info are unaffected — they swap only the
   * routing labels, leaving the ownership label intact on the issue.
   */
  ownerLabel?: string;
  /** Label added on claim (and the spec label removed) so re-polls skip it, e.g. 'vanguard:speccing'. */
  claimedLabel: string;
  /** Label added after a spec is generated — the agent-pass trigger, e.g. 'vanguard'. */
  agentLabel: string;
  /** Label added when triage flags the ticket as too vague, e.g. 'vanguard:needs-info'. */
  needsInfoLabel: string;
  gh?: GhRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * GitHub-issue SPEC primitives: trigger by label, triage each issue, then either generate+post a tech
 * spec and swap to the agent label, or request clarification and swap to needs-info. On failure the
 * trigger label is restored so a later poll retries it. (Issues have no states; everything is labels.)
 */
export function githubSpecPrimitives(opts: WatchGithubSpecOptions): SpecWatchPrimitives {
  const repo = opts.repoSlug;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () => (await fetcher.list({ labels: specLabels })).map((task) => ({ id: task.id })),
    claim: (id) => editGithubLabels(repo, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, opts.gh),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGithubIssue(repo, id, body, opts.gh),
        advance: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.agentLabel] }, opts.gh),
        toNeedsInfo: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] }, opts.gh),
      });
    },
    onFailure: async (id, error) => {
      await commentGithubIssue(repo, id, `Vanguard spec failed: ${String(error)}`, opts.gh);
      await editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, opts.gh);
    },
  };
}

/** Poll GitHub Issues and run each newly-ready (labeled) issue. */
export async function watchGithub(opts: WatchGithubOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubIssueWatchPrimitives(opts), opts, log);
}

export interface WatchGithubLoopV1Options {
  /** SPEC-pass options (label trigger, spec-gen, swap to the agent label). */
  spec: WatchGithubSpecOptions;
  /** AGENT-pass options. Supply needsInfoLabel to gate vague tickets out of the implement budget. */
  agent: WatchGithubOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Loop v1 over GitHub Issues: each poll runs the spec pass then the agent pass. */
export async function watchGithubLoopV1(opts: WatchGithubLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(githubSpecPrimitives(opts.spec), githubIssueWatchPrimitives(opts.agent), opts, log);
}

export interface WatchGithubProjectOptions {
  deps: RunGithubIssueDeps;
  projectNumber: number;
  /** Owner of the project (default: first segment of deps.repoSlug). */
  owner?: string;
  /** Only pick up board items with this label (optional). */
  label?: string;
  /** Status option name for ready-to-run items (e.g. 'Todo'). */
  triggerStatus: string;
  /** Status option name set on claim so re-polls skip the item. */
  claimedStatus: string;
  /** Status option name set after a PR opens. */
  reviewStatus: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/**
 * GitHub Projects v2 primitives: trigger by Status field value, claim/review by updating the Status
 * field via `gh project item-edit`. Field and option IDs are resolved once via `gh project field-list`
 * and `gh project view` and then cached for the lifetime of the primitives object.
 *
 * The Status option names (triggerStatus / claimedStatus / reviewStatus) must match the exact names
 * configured on the project's Status field — find them with:
 *   gh project field-list <projectNumber> --owner <owner> --format json
 */
interface ProjectMeta {
  projectNodeId: string;
  statusFieldId: string;
  statusOptionIds: Map<string, string>;
}

export function githubProjectWatchPrimitives(opts: WatchGithubProjectOptions): WatchPrimitives {
  const gh = opts.gh ?? defaultGhRunner;
  const owner = opts.owner ?? (opts.deps.repoSlug.split('/')[0] as string);
  const repo = opts.deps.repoSlug;
  const projectNumber = String(opts.projectNumber);

  // Populated on each listReady call; claim/review look up the project item node ID here.
  const itemNodeIds = new Map<string, string>();

  // Single cached promise: fetches project node ID and Status field in parallel, resolved once.
  let projectMeta: Promise<ProjectMeta> | undefined;

  function getProjectMeta(): Promise<ProjectMeta> {
    if (projectMeta === undefined) {
      projectMeta = Promise.all([
        gh(['project', 'view', projectNumber, '--owner', owner, '--format', 'json'])
          .then((out) => (JSON.parse(out) as { id: string }).id),
        gh(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']).then((out) => {
          const parsed = JSON.parse(out) as {
            fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
          };
          const field = parsed.fields.find((f) => f.name === 'Status');
          if (field === undefined) throw new Error(`GitHub project ${opts.projectNumber} has no "Status" field`);
          return { fieldId: field.id, optionIds: new Map(field.options?.map((o) => [o.name, o.id] as [string, string]) ?? []) };
        }),
      ]).then(([projectNodeId, { fieldId: statusFieldId, optionIds: statusOptionIds }]) => ({
        projectNodeId,
        statusFieldId,
        statusOptionIds,
      }));
    }
    return projectMeta;
  }

  async function setStatus(issueRef: string, statusName: string): Promise<void> {
    const { projectNodeId, statusFieldId, statusOptionIds } = await getProjectMeta();
    const nodeId = itemNodeIds.get(issueRef);
    if (nodeId === undefined) throw new Error(`Project item for ${issueRef} not in cache; call listReady first`);
    const optionId = statusOptionIds.get(statusName);
    if (optionId === undefined) throw new Error(`Status option "${statusName}" not found in project ${opts.projectNumber}`);
    await gh(['project', 'item-edit', '--id', nodeId, '--project-id', projectNodeId, '--field-id', statusFieldId, '--single-select-option-id', optionId]);
  }

  return {
    listReady: async () => {
      const out = await gh(['project', 'item-list', projectNumber, '--owner', owner, '--format', 'json', '--limit', '1000']);
      const parsed = JSON.parse(out) as {
        items: Array<{
          id: string;
          status?: string;
          content?: { type?: string; number?: number; repository?: string; labels?: string[] };
        }>;
      };
      itemNodeIds.clear();
      const ready: Array<{ id: string }> = [];
      for (const item of parsed.items) {
        const content = item.content;
        if (content === undefined || content.type !== 'Issue' || content.number === undefined) continue;
        const issueRef = `${content.repository ?? repo}#${content.number}`;
        itemNodeIds.set(issueRef, item.id);
        if (item.status !== opts.triggerStatus) continue;
        if (opts.label !== undefined && !(content.labels ?? []).includes(opts.label)) continue;
        ready.push({ id: issueRef });
      }
      return ready;
    },
    claim: (id) => setStatus(id, opts.claimedStatus),
    runOne: (id) => runGithubIssue(id, opts.deps),
    review: (id) => setStatus(id, opts.reviewStatus),
    onFailure: (id, error) => commentGithubIssue(repo, id, `Vanguard run failed: ${String(error)}`, gh),
  };
}

/** Poll GitHub Projects v2 and run each item in the trigger Status. */
export async function watchGithubProject(opts: WatchGithubProjectOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubProjectWatchPrimitives(opts), opts, log);
}

export interface WatchGitlabOptions {
  deps: RunGitlabIssueDeps;
  /** Trigger label: open issues carrying this label are picked for running. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label`.
   * Absent => only `label` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (trigger label removed) so re-polls skip it. */
  claimedLabel: string;
  /** Label added after an MR opens (claimed label auto-removed by GitLab scoped-label rule when same scope). */
  reviewLabel: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + swapped to this label and NO implement budget is spent.
   * Absent => behaviour is unchanged (no triage, straight to runGitlabIssue).
   */
  needsInfoLabel?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  /** Injectable runner for tests. Defaults to `defaultGlabRunner`. */
  gl?: GlabRunner;
}

/** GitLab issue primitives: trigger by label, claim/review by swapping scoped labels. */
export function gitlabWatchPrimitives(opts: WatchGitlabOptions): WatchPrimitives {
  const project = opts.deps.project;
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = new GitLabTaskFetcher(project, glab);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  return {
    listReady: async () => (await fetcher.list({ labels: agentLabels })).map((task) => ({ id: task.id })),
    claim: (id) =>
      // Explicitly remove trigger label so future polls don't pick it up again.
      // GitLab scoped :: only auto-removes within the same scope prefix.
      editGitlabLabels(project, id, { remove: [opts.label], add: [opts.claimedLabel] }, glab),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGitlabIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGitlabIssue(i, opts.deps), {
              comment: (body) => commentGitlabIssue(project, id, body, glab),
              toNeedsInfo: () =>
                editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, glab),
            }),
    review: (id) =>
      // Explicitly remove claimedLabel for robustness when non-scoped labels are configured.
      editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, glab),
    onFailure: (id, error) =>
      commentGitlabIssue(project, id, `Vanguard run failed: ${String(error)}`, glab),
  };
}

export interface WatchGitlabSpecOptions {
  /** Deps for the spec generator (no MR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  /** GitLab project path, e.g. `group/project`. */
  project: string;
  /** Trigger label: open issues with this label are picked for speccing. */
  specLabel: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `specLabel`.
   * Absent => only `specLabel` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (spec label removed) so re-polls skip it. */
  claimedLabel: string;
  /** Label added after a spec is generated — the agent-pass trigger. */
  agentLabel: string;
  /** Label added when triage flags the ticket as too vague. */
  needsInfoLabel: string;
  gl?: GlabRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * GitLab-issue SPEC primitives: trigger by label, triage each issue, then either generate+post a tech
 * spec and swap to the agent label, or request clarification and swap to needs-info. On failure the
 * trigger label is restored so a later poll retries it.
 */
export function gitlabSpecPrimitives(opts: WatchGitlabSpecOptions): SpecWatchPrimitives {
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () => (await fetcher.list({ labels: specLabels })).map((task) => ({ id: task.id })),
    claim: (id) =>
      editGitlabLabels(opts.project, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, glab),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGitlabIssue(opts.project, id, body, glab),
        advance: () =>
          editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.agentLabel] }, glab),
        toNeedsInfo: () =>
          editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] }, glab),
      });
    },
    onFailure: async (id, error) => {
      await commentGitlabIssue(opts.project, id, `Vanguard spec failed: ${String(error)}`, glab);
      // Restore spec label so next poll retries
      await editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, glab);
    },
  };
}

export interface WatchGitlabLoopV1Options {
  /** SPEC-pass options (label trigger, spec-gen, swap to the agent label). */
  spec: WatchGitlabSpecOptions;
  /** AGENT-pass options. Supply needsInfoLabel to gate vague tickets out of the implement budget. */
  agent: WatchGitlabOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

/** Poll GitLab Issues and run each newly-ready (labeled) issue. */
export async function watchGitlab(opts: WatchGitlabOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(gitlabWatchPrimitives(opts), opts, log);
}

/** Loop v1 over GitLab Issues: each poll runs the spec pass then the agent pass. */
export async function watchGitlabLoopV1(opts: WatchGitlabLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(gitlabSpecPrimitives(opts.spec), gitlabWatchPrimitives(opts.agent), opts, log);
}
