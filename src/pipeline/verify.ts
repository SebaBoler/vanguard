import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

export interface VerificationResult {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;        // over the combined stdout + stderr
  outputTail: string;    // last ~40 lines, for the PR body
}

const WORKDIR = '/workspace';

/** Marker files that indicate a Python project driven by pytest. */
const PYTHON_MARKERS = ['pyproject.toml', 'pytest.ini', 'setup.cfg'];

/**
 * Resolve the verification command. Precedence: explicit cmd (CLI flag) > VANGUARD_VERIFY_CMD env >
 * auto-detect from the worktree package.json > auto-detect Python (pytest) markers > undefined
 * (skip Proof of Work entirely — the caller must render that skip visibly, not drop it silently).
 * JS auto-detect: if package.json has a `test` script, build "<pm> install --frozen-lockfile && <pm>
 * run typecheck && <pm> test", including typecheck only when that script exists; pm from the
 * `packageManager` field (pnpm/yarn/npm), default npm. Python auto-detect: pyproject.toml/pytest.ini/
 * setup.cfg present -> "pytest".
 */
export async function resolveVerifyCommand(
  worktreePath: string,
  opts: { cmd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if (opts.cmd !== undefined && opts.cmd !== '') return opts.cmd;
  const envCmd = (opts.env ?? process.env).VANGUARD_VERIFY_CMD;
  if (envCmd !== undefined && envCmd !== '') return envCmd;

  let pkgRaw: string | undefined;
  try {
    pkgRaw = await readFile(join(worktreePath, 'package.json'), 'utf8');
  } catch {
    pkgRaw = undefined;
  }
  if (pkgRaw !== undefined) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string };
      const scripts = pkg.scripts ?? {};
      if (scripts.test === undefined) return undefined;
      const field = pkg.packageManager ?? '';
      const pm = field.startsWith('pnpm') ? 'pnpm' : field.startsWith('yarn') ? 'yarn' : 'npm';
      const parts = [`${pm} install --frozen-lockfile`];
      if (scripts.typecheck !== undefined) parts.push(`${pm} run typecheck`);
      parts.push(`${pm} test`);
      return parts.join(' && ');
    } catch {
      return undefined;
    }
  }

  for (const marker of PYTHON_MARKERS) {
    try {
      await readFile(join(worktreePath, marker), 'utf8');
      return 'pytest';
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Rendered in the PR body when no verify command could be resolved, so a skipped gate is visible, not silent. */
export function verifySkippedBlock(): string {
  return [
    '## Proof of work: SKIPPED',
    '',
    'No verify command resolved (no package.json test script, no pytest markers, and no `VANGUARD_VERIFY_CMD`).',
  ].join('\n');
}

/** Run the command inside the sandbox (host-driven) and attest the result. */
export async function runVerification(
  sandbox: IsolatedSandboxProvider,
  command: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const sh = sandbox.exec.bind(sandbox);
  const res = await sh(command, { cwd: WORKDIR, ...(signal !== undefined ? { signal } : {}) });
  const output = `${res.stdout}\n${res.stderr}`;
  const sha256 = createHash('sha256').update(output).digest('hex');
  const outputTail = output.split('\n').slice(-40).join('\n').trimEnd();
  return { command, exitCode: res.exitCode, passed: res.exitCode === 0, sha256, outputTail };
}

/**
 * Minimal failing-witness feedback for the verification repair loop (CEGIS-style, mirrors
 * renderConformanceFeedback): just the command, exit code, and output tail, so the resumed
 * implement session stays small and targeted.
 */
export function renderVerificationFeedback(result: VerificationResult): string {
  return [
    'The verification command failed. Make it pass:',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    '',
    'Output tail:',
    result.outputTail,
  ].join('\n');
}

/** Markdown Proof of Work block for the PR body. */
export function proofBlock(result: VerificationResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  return [
    `## Proof of work: ${status}`,
    '',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    `- sha256(output): \`${result.sha256}\``,
    '',
    '<details><summary>output tail</summary>',
    '',
    '```',
    result.outputTail,
    '```',
    '',
    '</details>',
  ].join('\n');
}
