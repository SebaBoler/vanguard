import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import {
  resolveVisualProofCommand,
  runVisualProof,
  visualProofBlock,
} from './visual-proof.js';

// ---------------------------------------------------------------------------
// Minimal shell argv parser (handles single-quoted args, the form shellQuote emits)
// ---------------------------------------------------------------------------
function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let started = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i += 1;
      started = true;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

// ---------------------------------------------------------------------------
// Fake sandbox
// ---------------------------------------------------------------------------
/**
 * A command-routing fake. The main command returns the provided stdout/stderr/exitCode;
 * `find`/`sha256sum`/`wc -c` commands return whatever the artifact map describes.
 */
function fakeSandbox(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Map of artifact sandbox path -> { sha256, bytes }. */
  artifacts?: Record<string, { sha256: string; bytes: number }>;
  /** When true, any `find` command rejects (simulating a listing failure). */
  findThrows?: boolean;
}): IsolatedSandboxProvider {
  const stdout = opts.stdout ?? '';
  const stderr = opts.stderr ?? '';
  const exitCode = opts.exitCode ?? 0;
  const artifacts = opts.artifacts ?? {};
  const paths = Object.keys(artifacts);

  const exec = async (command: string): Promise<ExecResult> => {
    if (command.startsWith('find ')) {
      if (opts.findThrows === true) throw new Error('find failed');
      return { stdout: paths.join('\n'), stderr: '', exitCode: 0 };
    }
    if (command.startsWith('sha256sum ')) {
      // Parse argv like a real shell: an unquoted path with a space splits into 2+ args,
      // so the lookup misses and the artifact is dropped (exercising the quoting fix).
      const args = parseShellArgs(command.slice('sha256sum '.length));
      const path = args.length === 1 ? (args[0] ?? '') : '';
      const entry = path === '' ? undefined : artifacts[path];
      if (entry === undefined) return { stdout: '', stderr: 'no such file', exitCode: 1 };
      return { stdout: `${entry.sha256}  ${path}\n`, stderr: '', exitCode: 0 };
    }
    if (command.startsWith('wc -c ')) {
      const args = parseShellArgs(command.slice('wc -c '.length));
      const path = args.length === 1 ? (args[0] ?? '') : '';
      const entry = path === '' ? undefined : artifacts[path];
      if (entry === undefined) return { stdout: '', stderr: 'no such file', exitCode: 1 };
      return { stdout: `${entry.bytes} ${path}\n`, stderr: '', exitCode: 0 };
    }
    // main command
    return { stdout, stderr, exitCode };
  };

  return { exec } as unknown as IsolatedSandboxProvider;
}

// ---------------------------------------------------------------------------
// resolveVisualProofCommand
// ---------------------------------------------------------------------------
describe('resolveVisualProofCommand', () => {
  it('returns explicit cmd immediately (wins over everything)', async () => {
    const result = await resolveVisualProofCommand('/nonexistent', {
      cmd: 'my-visual-cmd',
      env: { VANGUARD_VISUAL_PROOF_CMD: 'env-cmd' },
    });
    expect(result).toBe('my-visual-cmd');
  });

  it('returns env VANGUARD_VISUAL_PROOF_CMD when no explicit cmd', async () => {
    const result = await resolveVisualProofCommand('/nonexistent', {
      env: { VANGUARD_VISUAL_PROOF_CMD: 'env-cmd' },
    });
    expect(result).toBe('env-cmd');
  });

  it('empty cmd falls through to env', async () => {
    const result = await resolveVisualProofCommand('/nonexistent', {
      cmd: '',
      env: { VANGUARD_VISUAL_PROOF_CMD: 'env-cmd' },
    });
    expect(result).toBe('env-cmd');
  });

  it('returns undefined when neither cmd nor env is set', async () => {
    const result = await resolveVisualProofCommand('/nonexistent', { env: {} });
    expect(result).toBeUndefined();
  });

  it('does NOT auto-detect from package.json (test script yields undefined)', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vg-visual-'));
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'pnpm@8.0.0' }),
      );
      const result = await resolveVisualProofCommand(dir, { env: {} });
      expect(result).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runVisualProof
// ---------------------------------------------------------------------------
describe('runVisualProof', () => {
  it('returns passed=true and correct exitCode on success', async () => {
    const sandbox = fakeSandbox({ stdout: 'rendered', exitCode: 0 });
    const result = await runVisualProof(sandbox, 'render.sh');
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('render.sh');
  });

  it('returns passed=false and non-zero exitCode on failure', async () => {
    const sandbox = fakeSandbox({ stderr: 'render failed', exitCode: 2 });
    const result = await runVisualProof(sandbox, 'render.sh');
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('produces a stable sha256 over combined stdout+stderr', async () => {
    const sandbox = fakeSandbox({ stdout: 'out', stderr: 'err', exitCode: 0 });
    const result = await runVisualProof(sandbox, 'cmd');
    const expected = createHash('sha256').update('out\nerr').digest('hex');
    expect(result.sha256).toBe(expected);
  });

  it('sha256 is a 64-char hex string', async () => {
    const sandbox = fakeSandbox({ stdout: 'hello', stderr: 'world', exitCode: 0 });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('outputTail contains up to 40 lines trimmed', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const sandbox = fakeSandbox({ stdout: lines.join('\n'), exitCode: 0 });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.outputTail.split('\n').length).toBeLessThanOrEqual(40);
  });

  it('parses artifacts with correct path/sha256/bytes', async () => {
    const sandbox = fakeSandbox({
      exitCode: 0,
      artifacts: {
        '/workspace/.vanguard/visual-proof/shot.png': { sha256: 'a'.repeat(64), bytes: 1234 },
      },
    });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.artifacts).toEqual([
      { path: '/workspace/.vanguard/visual-proof/shot.png', sha256: 'a'.repeat(64), bytes: 1234 },
    ]);
  });

  it('filters out non-allowlisted extensions', async () => {
    const sandbox = fakeSandbox({
      exitCode: 0,
      artifacts: {
        '/workspace/.vanguard/visual-proof/shot.png': { sha256: 'a'.repeat(64), bytes: 10 },
        '/workspace/.vanguard/visual-proof/notes.txt': { sha256: 'b'.repeat(64), bytes: 20 },
        '/workspace/.vanguard/visual-proof/data.bin': { sha256: 'c'.repeat(64), bytes: 30 },
      },
    });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.artifacts.map((a) => a.path)).toEqual([
      '/workspace/.vanguard/visual-proof/shot.png',
    ]);
  });

  it('extension matching is case-insensitive', async () => {
    const sandbox = fakeSandbox({
      exitCode: 0,
      artifacts: {
        '/workspace/.vanguard/visual-proof/A.PNG': { sha256: 'a'.repeat(64), bytes: 1 },
        '/workspace/.vanguard/visual-proof/B.JPEG': { sha256: 'b'.repeat(64), bytes: 2 },
        '/workspace/.vanguard/visual-proof/C.Html': { sha256: 'c'.repeat(64), bytes: 3 },
      },
    });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.artifacts).toHaveLength(3);
  });

  it('accepts every allowlisted extension', async () => {
    const exts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'html', 'json'];
    const artifacts: Record<string, { sha256: string; bytes: number }> = {};
    exts.forEach((ext, i) => {
      artifacts[`/workspace/.vanguard/visual-proof/f${i}.${ext}`] = {
        sha256: String(i).repeat(64).slice(0, 64),
        bytes: i,
      };
    });
    const sandbox = fakeSandbox({ exitCode: 0, artifacts });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.artifacts).toHaveLength(exts.length);
  });

  it('keeps command result and sets artifacts:[] when listing fails', async () => {
    const sandbox = fakeSandbox({ stdout: 'ok', exitCode: 0, findThrows: true });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.artifacts).toEqual([]);
  });

  it('returns empty artifacts when the dir has no files', async () => {
    const sandbox = fakeSandbox({ exitCode: 0, artifacts: {} });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.artifacts).toEqual([]);
  });

  it('includes artifacts whose path contains spaces (paths are shell-quoted)', async () => {
    const spacedPath = '/workspace/.vanguard/visual-proof/my shot.png';
    const sandbox = fakeSandbox({
      exitCode: 0,
      artifacts: {
        [spacedPath]: { sha256: 'a'.repeat(64), bytes: 2048 },
      },
    });
    const result = await runVisualProof(sandbox, 'cmd');
    expect(result.artifacts).toEqual([
      { path: spacedPath, sha256: 'a'.repeat(64), bytes: 2048 },
    ]);
  });

  it('passes the AbortSignal through opts', async () => {
    let seenSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const sandbox = {
      exec: async (
        command: string,
        options?: { signal?: AbortSignal },
      ): Promise<ExecResult> => {
        if (!command.startsWith('find ') && !command.startsWith('sha256sum ')) {
          seenSignal = options?.signal;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    } as unknown as IsolatedSandboxProvider;
    await runVisualProof(sandbox, 'cmd', { signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// visualProofBlock
// ---------------------------------------------------------------------------
describe('visualProofBlock', () => {
  const baseResult = {
    command: 'render.sh',
    exitCode: 0,
    passed: true,
    sha256: 'abc123',
    outputTail: 'Rendered 3 screenshots',
    artifacts: [
      { path: '/workspace/.vanguard/visual-proof/shot.png', sha256: 'deadbeef', bytes: 4096 },
    ],
  };

  it('contains PASS when passed=true', () => {
    const block = visualProofBlock(baseResult);
    expect(block).toContain('## Visual proof: PASS');
    expect(block).not.toContain('## Visual proof: FAIL');
  });

  it('contains FAIL when passed=false', () => {
    const block = visualProofBlock({ ...baseResult, passed: false, exitCode: 1 });
    expect(block).toContain('## Visual proof: FAIL');
    expect(block).not.toContain('PASS');
  });

  it('contains the command', () => {
    expect(visualProofBlock(baseResult)).toContain('render.sh');
  });

  it('contains the sha256', () => {
    expect(visualProofBlock(baseResult)).toContain('abc123');
  });

  it('contains the exit code', () => {
    expect(visualProofBlock({ ...baseResult, exitCode: 7, passed: false })).toContain('7');
  });

  it('contains the artifact count', () => {
    expect(visualProofBlock(baseResult)).toContain('- artifacts: 1');
  });

  it('contains a per-artifact line', () => {
    const block = visualProofBlock(baseResult);
    expect(block).toContain('/workspace/.vanguard/visual-proof/shot.png');
    expect(block).toContain('4096 bytes');
    expect(block).toContain('deadbeef');
  });

  it('contains fenced output tail', () => {
    const block = visualProofBlock(baseResult);
    expect(block).toContain('```');
    expect(block).toContain('Rendered 3 screenshots');
  });

  it('shows artifacts: 0 and no per-artifact lines when empty', () => {
    const block = visualProofBlock({ ...baseResult, artifacts: [] });
    expect(block).toContain('- artifacts: 0');
    expect(block).not.toContain('bytes, sha256');
  });
});
