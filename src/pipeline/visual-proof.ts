import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { shellQuote } from '../agents/shell.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';

export interface VisualProofArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface VisualProofResult {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;        // over the combined stdout + stderr
  outputTail: string;    // last ~40 lines, for the PR body
  artifacts: VisualProofArtifact[];
}

const WORKDIR = '/workspace';

/** Default directory inside the sandbox where the command is expected to drop its artifacts. */
const ARTIFACT_DIR = '/workspace/.vanguard/visual-proof';

/** Lowercase extensions (with leading dot) we record as visual proof artifacts. */
const ARTIFACT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.html',
  '.json',
]);

/** A bound `sandbox.exec`; runs a command INSIDE the sandbox (never throws on non-zero exit). */
type SandboxRun = (
  command: string,
  options?: { cwd?: string; signal?: AbortSignal },
) => Promise<ExecResult>;

/**
 * Resolve the visual-proof command. Precedence: explicit cmd (CLI flag) >
 * VANGUARD_VISUAL_PROOF_CMD env > undefined (skip visual proof entirely).
 * Unlike the Proof of Work command, this never auto-detects from package.json — a visual
 * proof is opt-in only.
 */
export async function resolveVisualProofCommand(
  worktreePath: string,
  opts: { cmd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if (opts.cmd !== undefined && opts.cmd !== '') return opts.cmd;
  const envCmd = (opts.env ?? process.env).VANGUARD_VISUAL_PROOF_CMD;
  if (envCmd !== undefined && envCmd !== '') return envCmd;
  return undefined;
}

/**
 * Run the visual-proof command inside the sandbox (host-driven), attest its output, and build a
 * manifest of the artifacts it produced. Manifest-only for v1.3: artifacts are hashed in place and
 * never copied out to the host. Listing failures are swallowed (artifacts: []) so a broken visual
 * proof can never block the caller.
 */
export async function runVisualProof(
  sandbox: IsolatedSandboxProvider,
  command: string,
  opts?: { signal?: AbortSignal },
): Promise<VisualProofResult> {
  const sh: SandboxRun = sandbox.exec.bind(sandbox);
  const signal = opts?.signal;
  const res = await sh(command, { cwd: WORKDIR, ...(signal !== undefined ? { signal } : {}) });
  const output = `${res.stdout}\n${res.stderr}`;
  const sha256 = createHash('sha256').update(output).digest('hex');
  const outputTail = output.split('\n').slice(-40).join('\n').trimEnd();
  const artifacts = await listArtifacts(sh, ARTIFACT_DIR);
  return {
    command,
    exitCode: res.exitCode,
    passed: res.exitCode === 0,
    sha256,
    outputTail,
    artifacts,
  };
}

/** List + hash allowlisted artifacts under `dir`, hashing each in place. Never throws. */
async function listArtifacts(sh: SandboxRun, dir: string): Promise<VisualProofArtifact[]> {
  try {
    const found = await sh(`find ${shellQuote(dir)} -type f`, { cwd: WORKDIR });
    const paths = found.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line !== '')
      .filter((path) => ARTIFACT_EXTENSIONS.has(extname(path).toLowerCase()));

    const artifacts: VisualProofArtifact[] = [];
    for (const path of paths) {
      const hashRes = await sh(`sha256sum ${shellQuote(path)}`, { cwd: WORKDIR });
      const sizeRes = await sh(`wc -c ${shellQuote(path)}`, { cwd: WORKDIR });
      const sha = hashRes.stdout.trim().split(/\s+/)[0] ?? '';
      const bytes = Number.parseInt(sizeRes.stdout.trim().split(/\s+/)[0] ?? '', 10);
      if (sha === '' || Number.isNaN(bytes)) continue;
      artifacts.push({ path, sha256: sha, bytes });
    }
    return artifacts;
  } catch {
    return [];
  }
}

/**
 * Synthetic FAILED result for when a configured visual proof could not be executed (sandbox crash,
 * cancel, timeout, container failure, ...). exitCode -1 marks "did not run"; the error is recorded in
 * the output tail and attested. This keeps a requested-but-failed proof visible instead of silently
 * vanishing.
 */
function failedVisualProof(command: string, err: unknown): VisualProofResult {
  const message = err instanceof Error ? err.message : String(err);
  const outputTail = `visual proof execution failed: ${message}`
    .split('\n')
    .slice(-40)
    .join('\n')
    .trimEnd();
  const sha256 = createHash('sha256').update(outputTail).digest('hex');
  return { command, exitCode: -1, passed: false, sha256, outputTail, artifacts: [] };
}

/**
 * Resolve and run the visual proof for a run. Returns undefined ONLY when no visual proof command is
 * configured (flag/env both absent). If a command IS configured but resolving or running it throws,
 * a synthetic FAIL result is returned (never undefined) so a requested proof can never silently
 * disappear from the PR body, labels, or run record. Never throws.
 */
export async function resolveAndRunVisualProof(
  sandbox: IsolatedSandboxProvider,
  worktreePath: string,
  opts: { cmd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<VisualProofResult | undefined> {
  let command: string | undefined;
  try {
    command = await resolveVisualProofCommand(worktreePath, {
      ...(opts.cmd !== undefined ? { cmd: opts.cmd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    if (command === undefined) return undefined;
    return await runVisualProof(sandbox, command, opts.signal !== undefined ? { signal: opts.signal } : {});
  } catch (err: unknown) {
    // A command was configured but couldn't be executed — surface it as a FAIL, never as "skipped".
    if (command === undefined) return undefined;
    console.error('visual proof execution failed (recorded as FAIL):', err);
    return failedVisualProof(command, err);
  }
}

/** Markdown visual-proof block for the PR body. */
export function visualProofBlock(result: VisualProofResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const artifactLines = result.artifacts.map(
    (a) => `- ${a.path} (${a.bytes} bytes, sha256 ${a.sha256})`,
  );
  return [
    `## Visual proof: ${status}`,
    '',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    `- sha256(output): \`${result.sha256}\``,
    `- artifacts: ${result.artifacts.length}`,
    ...(artifactLines.length > 0 ? ['', ...artifactLines] : []),
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
