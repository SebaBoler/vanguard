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
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'jwt', re: /eyJ[A-Za-z0-9._-]{10,}/g, replacement: '[REDACTED-JWT]' },
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
const TEST_PATH = /\.(test|fixture)\.[cm]?[jt]sx?$/i;
export function isTestPath(file: string): boolean {
  return TEST_PATH.test(file);
}

/**
 * Scan a unified git diff. Inspects only ADDED lines (lines starting with '+', excluding the
 * '+++' file header). Tracks the current file from '+++ b/<path>' headers so findings carry a path.
 * Added lines in test/fixture files are skipped (they legitimately contain fake secrets).
 */
export function scanForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let currentFile = '(unknown)';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const m = ADDED_FILE_HEADER.exec(line);
      if (m !== null && m[1] !== undefined) currentFile = m[1];
      continue;
    }
    if (!line.startsWith('+')) continue;
    if (isTestPath(currentFile)) continue;
    const added = line.slice(1);
    const matched = SECRET_PATTERNS.filter((pattern) => added.search(pattern.re) !== -1);
    if (matched.length === 0) continue;
    const masked = redactTokens(added).slice(0, MASKED_EXCERPT_MAX_CHARS);
    for (const pattern of matched) {
      findings.push({ file: currentFile, patternName: pattern.name, masked });
    }
  }
  return findings;
}
