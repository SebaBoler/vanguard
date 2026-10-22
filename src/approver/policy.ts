import { createHash } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import { resolveRemoteBaseRef } from '../core/base-branch.js';
import type { ApproverPolicy } from './types.js';

/**
 * `.vanguard/approver.json`, read from the base branch only (never the working tree or the PR
 * head) — see `loadPolicy` below. Unknown extra keys are tolerated (forward-compat); every field
 * other than schemaVersion/enabled/requiredChecks/reviewAuthors/pathRules/shape/ledger/auditSample
 * has a default so a minimal policy still validates. Security-relevant fields have no default.
 */
export const approverPolicySchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  factoryBranchPrefix: z.string().default('chore/vanguard-'),
  requiredChecks: z.array(z.object({ name: z.string(), appId: z.number().int() })),
  /** Login allow-list for the review that carries the marker. Required and non-empty: a missing list fails closed (policy-unreadable). */
  reviewAuthors: z.array(z.string().min(1)).min(1),
  testGlobs: z.array(z.string()).default(['**/*.test.ts']),
  pathRules: z.record(z.string(), z.array(z.string())),
  shape: z.object({ maxLines: z.number().int().positive(), maxFiles: z.number().int().positive() }),
  ledger: z.object({ windowDays: z.number().int().positive(), maxLines: z.number().int().positive() }),
  auditSample: z.object({ p: z.number().min(0).max(1) }),
});

export interface LoadedPolicy {
  policy: ApproverPolicy;
  policyHash: string;
  raw: string;
}

/** Sentinel hash recorded when the policy could not be loaded or validated. */
export const POLICY_HASH_NONE = 'none';

function sha256hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Read `.vanguard/approver.json` from `origin/<base>` via `git show` — never the working tree, never
 * the PR head. Returns `undefined` when the file is missing, not JSON, or fails schema validation;
 * the caller then records `rulesFired: ['policy-unreadable']` and still writes a decision record.
 */
export async function loadPolicy(repoPath: string, base: string): Promise<LoadedPolicy | undefined> {
  let raw: string;
  try {
    await resolveRemoteBaseRef(repoPath, base, { label: 'approver', keepLocalIfAhead: false });
    raw = (await execa('git', ['show', `refs/remotes/origin/${base}:.vanguard/approver.json`], { cwd: repoPath, stripFinalNewline: false })).stdout;
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = approverPolicySchema.safeParse(json);
  if (!parsed.success) return undefined;
  return { policy: parsed.data as ApproverPolicy, policyHash: `sha256:${sha256hex(raw)}`, raw };
}

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Compile a small, git-pathspec-like glob to a RegExp:
 *  - `**\/` at the start: zero or more leading path segments.
 *  - `**` elsewhere: any characters, `/` included (so a trailing `/**` matches anything under the
 *    directory, but not the bare directory name itself).
 *  - `*`: any characters except `/`. `?`: one character except `/`. Everything else: literal.
 * Matching is case-sensitive, against the repo-relative POSIX path git prints.
 */
export function compileGlob(pattern: string): RegExp {
  let rest = pattern;
  let prefix = '';
  if (rest.startsWith('**/')) {
    prefix = '(?:.*/)?';
    rest = rest.slice(3);
  }
  let body = '';
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '*' && rest[i + 1] === '*') {
      body += '.*';
      i += 2;
      continue;
    }
    const c = rest[i]!;
    if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += escapeRegExpChar(c);
    i += 1;
  }
  return new RegExp(`^${prefix}${body}$`, 's');
}

/** All path-rule keys whose globs match `path`. */
export function matchingPathRuleKeys(pathRules: Record<string, string[]>, path: string): string[] {
  return Object.keys(pathRules).filter((key) => pathRules[key]!.some((glob) => matchGlob(glob, path)));
}

export function matchGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path);
}
