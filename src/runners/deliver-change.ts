// Imported through the pipeline.js shim on purpose: source-adapter.test.ts mocks '../pipeline/pipeline.js' and
// relies on this module hitting the same mock. Re-point that mock when the shim goes (see pipeline.ts).
import { commitStage, publishForReview, pushToExistingBranch } from '../pipeline/pipeline.js';
import { scanForSecrets } from '../core/secret-scan.js';
import { scanCommitClosingKeywords } from '../pipeline/conformance-gate.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { CommitClosingLeak } from '../pipeline/conformance-gate.js';
import type { RunContext } from '../core/vanguard.js';
import type { CommandRunner, PublishOptions } from '../pipeline/pipeline.js';

/**
 * Deliver a reviewed change: the one place that turns a finished worktree into something on the
 * remote. Order is fixed and is the point: secret scan on the outgoing diff (nothing with a secret
 * ever reaches a commit), commit, closing-keyword scan of the new commits, then either open a new
 * PR/MR (first delivery) or push onto the existing PR branch (revision). Both runners call this; the
 * invariants live here and nowhere else.
 */

export interface CommitAuthor {
  name: string;
  email: string;
}

export type DeliveryTarget =
  | {
      kind: 'new-pr';
      title: string;
      /** Built after the commit so it can carry the closing-keyword leaks found in the new commits. */
      body: (info: { commitLeaks: CommitClosingLeak[] }) => string;
      draft?: boolean;
      baseBranch?: string;
      cli?: PublishOptions['cli'];
      /** Injected git/gh runner (tests). */
      runner?: CommandRunner;
    }
  | {
      kind: 'existing-branch';
      prHeadRef: string;
      pushToken?: string;
      host?: string;
      runner?: CommandRunner;
    };

export interface DeliverChangeOptions {
  /** Task id for log lines and the closing-keyword scan. */
  taskId: string;
  commitMessage: string;
  /** White-label identity for the commit and the pre-push rebase; default Vanguard. */
  commitAuthor?: CommitAuthor;
  target: DeliveryTarget;
  /** Scan the new commits for `Closes #N` against this base (a partial delivery must not auto-close). */
  closingKeywordBase?: string;
}

export type DeliverChangeResult =
  | { kind: 'secret-blocked'; block: SecretBlock }
  | { kind: 'no-changes' }
  /** new-pr: the branch was pushed and a PR/MR opened; headSha is the pushed head (rebase may have rewritten the commit). */
  | { kind: 'delivered-pr'; sha: string; headSha: string; prUrl: string; commitLeaks: CommitClosingLeak[] }
  /** existing-branch: the commit was pushed onto the PR head. */
  | { kind: 'delivered-push'; sha: string; headSha: string; commitLeaks: CommitClosingLeak[] };

/**
 * The secret gate: scan an outgoing diff, log the masked findings, and return the block to report.
 * Nothing with a secret ever reaches a commit; a scan error blocks too, as a precaution. Exported so a
 * caller that must gate earlier than the commit (revise's --out preview) runs the same scan.
 */
export function scanOutgoingForSecrets(outgoing: string, taskId: string, phase: 'publish' | 'revise push' = 'publish'): SecretBlock | undefined {
  try {
    const findings = scanForSecrets(outgoing);
    if (findings.length === 0) return undefined;
    console.error(
      `vanguard: secret scan blocked ${phase} for ${taskId}:`,
      findings.map((f) => `${f.file} [${f.patternName}] ${f.masked}`).join('; '),
    );
    return { reason: 'findings', findings };
  } catch (err) {
    console.error(`vanguard: secret scan failed for ${taskId}, blocking ${phase} as a precaution:`, err);
    return { reason: 'scan-error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function deliverChange(ctx: RunContext, opts: DeliverChangeOptions): Promise<DeliverChangeResult> {
  // Gate before the commit: a push happens before any label can be attached, so the raw secret must
  // never reach a commit in the first place. Always the worktree's own diff — never a caller's snapshot.
  const block = scanOutgoingForSecrets(await ctx.wm.diff(ctx.worktreePath), opts.taskId, opts.target.kind === 'new-pr' ? 'publish' : 'revise push');
  if (block !== undefined) return { kind: 'secret-blocked', block };

  const identity = opts.commitAuthor !== undefined ? { authorName: opts.commitAuthor.name, authorEmail: opts.commitAuthor.email } : {};
  const commit = await commitStage(ctx, { message: opts.commitMessage, ...identity });
  if (!commit.committed) return { kind: 'no-changes' };
  const sha = commit.sha ?? 'unknown';

  // A rebase merge closes the issue per commit message regardless of the PR body, so a partial
  // result surfaces any commit-level `Closes #N` as a blocking warning in the body.
  const commitLeaks = opts.closingKeywordBase !== undefined
    ? scanCommitClosingKeywords(await ctx.wm.commitMessages(ctx.worktreePath, opts.closingKeywordBase), opts.taskId)
    : [];

  const { target } = opts;
  if (target.kind === 'new-pr') {
    const pr = await publishForReview(ctx, {
      title: target.title,
      body: target.body({ commitLeaks }),
      ...(target.draft !== undefined ? { draft: target.draft } : {}),
      ...(target.baseBranch !== undefined ? { baseBranch: target.baseBranch } : {}),
      ...(target.cli !== undefined ? { cli: target.cli } : {}),
      ...(target.runner !== undefined ? { runner: target.runner } : {}),
      // Same identity as the commit: the pre-push rebase replays the commits.
      ...identity,
    });
    // The pre-push rebase may have rewritten the commit; the review marker must name the pushed head.
    return { kind: 'delivered-pr', sha, headSha: pr.headSha ?? sha, prUrl: pr.prUrl, commitLeaks };
  }
  await pushToExistingBranch(ctx, {
    prHeadRef: target.prHeadRef,
    ...(target.pushToken !== undefined ? { pushToken: target.pushToken, host: target.host ?? 'github.com' } : {}),
    ...(target.runner !== undefined ? { runner: target.runner } : {}),
  });
  return { kind: 'delivered-push', sha, headSha: sha, commitLeaks };
}
