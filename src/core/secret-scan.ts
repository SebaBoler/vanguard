/**
 * Shared credential-pattern set. `redactTokens` masks secrets in text before it is logged or
 * posted as a comment (e.g. codex stdout/stderr); `scanForSecrets` uses the same patterns to gate
 * the outgoing diff before a PR is published. One set, two consumers — never duplicate a pattern.
 */

export interface SecretPattern {
  /** Stable, non-sensitive identifier surfaced in reports/logs, e.g. 'jwt', 'bearer', 'openai-key'. */
  name: string;
  re: RegExp;
  /** Replacement used by redactTokens; removes the matched secret from the output. */
  replacement: string;
  /**
   * Gate-only refinement. When present, scanForSecrets keeps a match ONLY if this returns true,
   * given the matched credential value. redactTokens IGNORES it — over-redacting logs is
   * harmless; under-gating is not. Absent → always kept (JWT/Bearer/sk-/json-token-field
   * detection stays unconditional).
   */
  refine?: (value: string) => boolean;
}

const ALLOWLIST_MARKER = /(?:vanguard-allow-secret|pragma:\s*allowlist\s*secret|gitleaks:allow)/i;
// An assignment RHS that is a code reference (a member access), not a string literal, is never a
// secret. Covers common request/context/web objects so e.g. `const cookieToken = request.cookies…`
// (a cookie read, not a hardcoded credential) isn't flagged.
const CODE_REFERENCE_PREFIX =
  /^(?:process\.env|import\.meta\.env|os\.environ|req\.|request\.|res\.|response\.|ctx\.|context\.|config\.|this\.|event\.|params\.|props\.|state\.|headers\.|cookies\.|session\.|window\.|document\.|globalThis\.|env\.)/;
// A dotted identifier chain (`opts.pushToken`, `deps.auth.token`) is a code reference, not a
// credential — real secrets never look like short identifier segments joined by dots. JWTs also
// contain dots but their base64url segments don't parse as identifiers (and the unconditional
// `jwt` pattern covers them regardless of this refinement).
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const UPPER_SNAKE_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;
// Suffix restricted to digits-only, letters-only, or separator-led continuation — real secrets
// mix letters and digits together (e.g. 'testAbc123Secret...'), which this deliberately excludes
// so mixed-content values fall through to the entropy check instead of being dismissed outright.
const PLACEHOLDER_VALUE =
  /^(?:changeme|example|placeholder|redacted|your[_-]?|test|dummy|fake|sample|none|null|undefined|true|false)(?:[0-9]*|[a-z]*|[_-]\w*)$/i;
const ANGLE_PLACEHOLDER = /^<.*>$/;
const SAME_CHAR_RUN = /^(.)\1*$/;

/** Minimum bits/char below which an assignment value is treated as low-entropy (dictionary-like), not a real secret. */
const ASSIGNMENT_ENTROPY_THRESHOLD = 3.0;

/** Shannon entropy of a string in bits/char. Higher entropy correlates with random credential material. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Conservative (fail-closed) heuristic for the broad `assignment` pattern: reject only on clear
 * non-secret signals (code/env reference, placeholder text, low entropy). Keeps ambiguous matches
 * as findings. The allowlist marker is handled globally in scanForSecrets, not here.
 */
function isLikelyAssignedSecret(value: string): boolean {
  if (CODE_REFERENCE_PREFIX.test(value)) return false;
  if (IDENTIFIER_CHAIN.test(value)) return false;
  if (UPPER_SNAKE_IDENTIFIER.test(value)) return false;
  if (PLACEHOLDER_VALUE.test(value) || ANGLE_PLACEHOLDER.test(value) || SAME_CHAR_RUN.test(value)) return false;
  if (shannonEntropy(value) < ASSIGNMENT_ENTROPY_THRESHOLD) return false;
  return true;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Require the full 3-segment JWT structure (header.payload.signature, all base64url). The old
  // `eyJ[A-Za-z0-9._-]{10,}` matched any eyJ-prefixed base64 run and false-positived on package-lock
  // integrity hashes (e.g. pnpm-lock.yaml `integrity: sha512-...eyJ...`), which are content hashes,
  // not secrets. Real JWTs always carry two internal dots; integrity hashes never do.
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, replacement: '[REDACTED-JWT]' },
  { name: 'bearer', re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: '$1[REDACTED]' },
  {
    name: 'json-token-field',
    re: /("(?:access_token|refresh_token|id_token|OPENAI_API_KEY|api_key)"\s*:\s*")[^"]+"/gi,
    replacement: '$1[REDACTED]"',
  },
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED-KEY]' },
  {
    name: 'assignment',
    re: /((?:token|api[_-]?key|secret|password|auth)\s*[=:]\s*['"]?)([A-Za-z0-9_.~+\-/=]{12,})/gi,
    replacement: '$1[REDACTED]',
    refine: isLikelyAssignedSecret,
  },
];

/** Mask credential material in a string for safe logging. */
export function redactTokens(s: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern.re, pattern.replacement), s);
}

export interface SecretFinding {
  /** Repo-relative path from the diff's `+++ b/<path>` header, or '(unknown)'. */
  file: string;
  /** Pattern name that matched (never the secret value). */
  patternName: string;
  /** A redactTokens-masked excerpt of the offending added line, truncated. */
  masked: string;
}

const MASKED_EXCERPT_MAX_CHARS = 200;
const ADDED_FILE_HEADER = /^\+\+\+ b\/(.+)$/;

// Test/fixture files legitimately carry fake secret material (they exercise this very scanner), and
// are the #1 false-positive source in every regex secret scanner. Exclude them from the publish
// gate — the agent never holds real secrets anyway (nonce/tmpfs/proxy), so a real leak here is
// implausible, and GitHub secret scanning / push protection is the real backstop for prod files.
// One rule per naming convention (mirrors SECRET_PATTERNS above) so each is independently testable
// and adding a new language's convention never grows the others. The `tests/`/`__tests__/` directory
// rule is intentionally broad — it also covers non-test helper modules that sit alongside tests
// (e.g. tests/helpers.py) and carry the same fixture secrets, and is the one that matched the live
// incident path (apps/.../tests/...).
const TEST_PATH_RULES: readonly RegExp[] = [
  /[.-](?:test|spec|fixture)\.[cm]?[jt]sx?$/i, // JS/TS: *.test.ts, *.spec.ts, *.fixture.tsx, *.e2e-spec.ts (+ cjs/mjs)
  /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/i, // Python: test_*.py, *_test.py, conftest.py
  /(?:^|\/)(?:tests|__tests__)\//i, // any path under a tests/ or __tests__/ directory
];
export function isTestPath(file: string): boolean {
  return TEST_PATH_RULES.some((re) => re.test(file));
}

/**
 * Scan a unified git diff. Inspects only ADDED lines (lines starting with '+', excluding the
 * '+++' file header). Tracks the current file from '+++ b/<path>' headers so findings carry a path.
 * Added lines in test/fixture files are skipped (they legitimately contain fake secrets), as are
 * lines carrying an ALLOWLIST_MARKER comment.
 */
export function scanForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let currentFile = '(unknown)';
  let currentFileIsTest = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const m = ADDED_FILE_HEADER.exec(line);
      if (m !== null && m[1] !== undefined) currentFile = m[1];
      currentFileIsTest = isTestPath(currentFile);
      continue;
    }
    if (!line.startsWith('+')) continue;
    if (currentFileIsTest) continue;
    const added = line.slice(1);
    if (ALLOWLIST_MARKER.test(added)) continue;
    const matched = SECRET_PATTERNS.filter((pattern) => {
      const refine = pattern.refine ?? (() => true);
      // Check every match on the line, not just the first — a leading placeholder-shaped
      // assignment must not shadow a genuine secret assigned later on the same line.
      for (const m of added.matchAll(pattern.re)) {
        const value = m[m.length - 1] ?? m[0];
        if (refine(value)) return true;
      }
      return false;
    });
    if (matched.length === 0) continue;
    const masked = redactTokens(added).slice(0, MASKED_EXCERPT_MAX_CHARS);
    for (const pattern of matched) {
      findings.push({ file: currentFile, patternName: pattern.name, masked });
    }
  }
  return findings;
}

/** Why publish was blocked by the secret scan: real findings, or the scan itself failing (precautionary block). */
export type SecretBlock = { reason: 'findings'; findings: SecretFinding[] } | { reason: 'scan-error'; message: string };

const FINDINGS_BLOCK_HEADER =
  '🔒 Vanguard blocked publish — the secret scan found credential-shaped content in the outgoing diff. ' +
  'No PR was opened. Findings are **masked**; review the listed lines.';

const SCAN_ERROR_BLOCK_HEADER =
  '🔒 Vanguard blocked publish as a precaution — the secret scan itself failed to run, so the outgoing ' +
  'diff could not be verified clean. No PR was opened.';

/**
 * Render the GitHub/GitLab/Linear comment body for a secret-scan block. Uses only
 * `SecretFinding.file/patternName/masked` (already redactTokens-masked) — the raw secret is
 * structurally unreachable — and never interpolates the raw diff or exception payload.
 */
export function renderSecretBlockComment(block: SecretBlock): string {
  if (block.reason === 'scan-error') {
    return [SCAN_ERROR_BLOCK_HEADER, '', `Error: ${block.message}`].join('\n');
  }
  const lines = block.findings.map((f) => `- \`${f.file}\` [${f.patternName}] ${f.masked}`);
  return [FINDINGS_BLOCK_HEADER, '', ...lines].join('\n');
}
