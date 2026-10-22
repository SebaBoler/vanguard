import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { VanguardError } from '../core/errors.js';
import type { Decision, DecisionRecord } from './types.js';

const DENY_PR_SUBCOMMANDS = new Set(['merge', 'ready', 'edit', 'close', 'reopen', 'review']);

/**
 * Denylist over argv for any gh call that could merge, approve, or change labels — shadow mode must
 * be structurally incapable of those actions. Applied by wrapping every GhRunner the engine uses.
 */
export function assertShadowSafeGhArgs(args: string[]): void {
  const [cmd, sub] = args;
  const refuse = (): never => {
    throw new VanguardError(`shadow mode: refusing gh call "${args.join(' ')}"`);
  };
  if (cmd === 'pr' && sub !== undefined && DENY_PR_SUBCOMMANDS.has(sub)) refuse();
  if (cmd === 'label') refuse();
  if (cmd === 'issue' && sub === 'edit') refuse();
  if (args.some((a) => a === '--add-label' || a === '--remove-label' || a === '--approve' || a === '--request-changes')) refuse();
  if (cmd === 'api') {
    const methodIdx = args.findIndex((a) => a === '-X' || a === '--method');
    const method = (methodIdx !== -1 ? args[methodIdx + 1] : 'GET')?.toUpperCase();
    if (method !== undefined && !['GET', 'POST', 'PATCH'].includes(method)) refuse();
    const path = args.find((a) => a.includes('/repos/') || a.startsWith('repos/'));
    if (path !== undefined && (/\/labels(\?|$)/.test(path) || /\/merge(\?|$)/.test(path) || /\/reviews(\?|$)/.test(path) || /\/pulls\/\d+$/.test(path))) {
      refuse();
    }
  }
}

/** Wrap a GhRunner so any shadow-unsafe argv throws before it reaches gh — the second, independent guard layer. */
export function shadowSafeGhRunner(gh: GhRunner): GhRunner {
  return async (args: string[]): Promise<string> => {
    assertShadowSafeGhArgs(args);
    return gh(args);
  };
}

function summaryBody(decision: Decision, record: DecisionRecord): string {
  return [
    `Verdict: ${decision.verdict}`,
    decision.rulesFired.length === 0 ? '(no rules fired)' : decision.rulesFired.map((r) => `- ${r}`).join('\n'),
    `Signals: files=${record.signals.files} lines=${record.signals.lines} testFilesDeleted=${record.signals.testFilesDeleted} testCasesDelta=${record.signals.testCasesDelta} exportsRemoved=${record.signals.exportsRemoved} newDependency=${record.signals.newDependency}`,
    `Audit: p=${decision.auditSample.p} hit=${decision.auditSample.hit}`,
    `Policy: ${record.policyHash}`,
  ].join('\n');
}

interface GhCheckRunsLookup {
  check_runs?: Array<{ id: number; external_id?: string }>;
}

/**
 * `vanguard/approver` check run on the head SHA, conclusion `neutral` in shadow mode regardless of
 * verdict. Idempotent per (PR, head SHA) via `external_id`: PATCHes an existing run, else POSTs.
 * A `checks: write` permission failure is swallowed — the decision record is the primary artifact.
 */
export async function publishCheckRun(
  gh: GhRunner,
  repoSlug: string,
  headSha: string,
  prNumber: number,
  decision: Decision,
  record: DecisionRecord,
): Promise<void> {
  const safeGh = shadowSafeGhRunner(gh);
  const externalId = `${prNumber}:${headSha}`;
  const title = `${decision.verdict} (shadow)`;
  const summary = summaryBody(decision, record);
  try {
    const existing = await safeGh(['api', `repos/${repoSlug}/commits/${headSha}/check-runs?check_name=vanguard%2Fapprover`]);
    const parsed = JSON.parse(existing) as GhCheckRunsLookup;
    const match = (parsed.check_runs ?? []).find((r) => r.external_id === externalId);
    const fields = [
      '-f', 'name=vanguard/approver',
      '-f', `head_sha=${headSha}`,
      '-f', 'status=completed',
      '-f', 'conclusion=neutral',
      '-f', `external_id=${externalId}`,
      '-f', `output[title]=${title}`,
      '-f', `output[summary]=${summary}`,
    ];
    if (match !== undefined) {
      await safeGh(['api', '--method', 'PATCH', `repos/${repoSlug}/check-runs/${match.id}`, ...fields]);
    } else {
      await safeGh(['api', '--method', 'POST', `repos/${repoSlug}/commits/${headSha}/check-runs`, ...fields]);
    }
  } catch {
    // a checks:write permission failure (or any publish failure) must not abort the run.
  }
}

const COMMENT_HEADING = '## Vanguard Approver (shadow mode)';

function commentBody(decision: Decision, record: DecisionRecord): string {
  return [
    COMMENT_HEADING,
    '',
    `Verdict: **${decision.verdict}**`,
    '',
    decision.rulesFired.length === 0 ? 'No rules fired.' : decision.rulesFired.map((r) => `- ${r}`).join('\n'),
    '',
    `Signals: files=${record.signals.files}, lines=${record.signals.lines}, testFilesDeleted=${record.signals.testFilesDeleted}, testCasesDelta=${record.signals.testCasesDelta}, exportsRemoved=${record.signals.exportsRemoved}, newDependency=${record.signals.newDependency}`,
    '',
    '_Shadow mode — nothing was merged, approved or labelled._',
    '',
    `<!-- vanguard-approver: ${record.headSha ?? 'none'} -->`,
  ].join('\n');
}

interface GhComment {
  body?: string;
}

/** A human-readable copy of the decision, deduped per head SHA by a hidden marker. Nothing ever parses this comment. */
export async function commentDecision(
  gh: GhRunner,
  repoSlug: string,
  prNumber: number,
  decision: Decision,
  record: DecisionRecord,
): Promise<void> {
  const safeGh = shadowSafeGhRunner(gh);
  const marker = `<!-- vanguard-approver: ${record.headSha ?? 'none'} -->`;
  try {
    const out = await safeGh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'comments']);
    const parsed = JSON.parse(out) as { comments?: GhComment[] };
    if ((parsed.comments ?? []).some((c) => c.body?.includes(marker) === true)) return;
  } catch {
    // best-effort dedupe lookup; fall through and post
  }
  await safeGh(['pr', 'comment', String(prNumber), '--repo', repoSlug, '--body', commentBody(decision, record)]);
}

export { defaultGhRunner };
