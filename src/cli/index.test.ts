import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Command } from './args.js';

vi.mock('./run.js', () => ({ runCommand: vi.fn(async () => undefined) }));
vi.mock('./watch.js', () => ({ watchCommand: vi.fn(async () => undefined) }));
vi.mock('./doctor.js', () => ({ doctorCommand: vi.fn(async () => undefined) }));
vi.mock('./doctor-prs.js', () => ({ doctorPrsCommand: vi.fn(async () => undefined) }));
vi.mock('./review-pr.js', () => ({ reviewPrCommand: vi.fn(async () => undefined) }));
vi.mock('./research.js', () => ({ researchCommand: vi.fn(async () => undefined) }));
vi.mock('./revise-pr.js', () => ({ revisePrCommand: vi.fn(async () => undefined) }));
vi.mock('./watch-prs.js', () => ({ watchPrsCommand: vi.fn(async () => undefined) }));
vi.mock('./review-mr.js', () => ({ reviewMrCommand: vi.fn(async () => undefined) }));
vi.mock('./watch-mrs.js', () => ({ watchMrsCommand: vi.fn(async () => undefined) }));
vi.mock('./doctor-mrs.js', () => ({ doctorMrsCommand: vi.fn(async () => undefined) }));
vi.mock('./eval.js', () => ({ evalCommand: vi.fn(async () => undefined) }));
vi.mock('./stats.js', () => ({ statsCommand: vi.fn(async () => undefined) }));
vi.mock('./memory.js', () => ({ memoryCommand: vi.fn(async () => undefined) }));
vi.mock('./gc.js', () => ({
  runGc: vi.fn(async () => ({ containers: [], networks: [], branches: [] })),
}));
vi.mock('./args.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./args.js')>();
  return { ...actual, parseCli: vi.fn() };
});

import { runCommand } from './run.js';
import { watchCommand } from './watch.js';
import { doctorCommand } from './doctor.js';
import { doctorPrsCommand } from './doctor-prs.js';
import { reviewPrCommand } from './review-pr.js';
import { researchCommand } from './research.js';
import { revisePrCommand } from './revise-pr.js';
import { watchPrsCommand } from './watch-prs.js';
import { reviewMrCommand } from './review-mr.js';
import { watchMrsCommand } from './watch-mrs.js';
import { doctorMrsCommand } from './doctor-mrs.js';
import { evalCommand } from './eval.js';
import { statsCommand } from './stats.js';
import { memoryCommand } from './memory.js';
import { runGc } from './gc.js';
import { parseCli, USAGE } from './args.js';

const allHandlers = {
  run: runCommand,
  watch: watchCommand,
  doctor: doctorCommand,
  'doctor-prs': doctorPrsCommand,
  'review-pr': reviewPrCommand,
  research: researchCommand,
  'revise-pr': revisePrCommand,
  'watch-prs': watchPrsCommand,
  'review-mr': reviewMrCommand,
  'watch-mrs': watchMrsCommand,
  'doctor-mrs': doctorMrsCommand,
  eval: evalCommand,
  stats: statsCommand,
  memory: memoryCommand,
  gc: runGc,
} as const;

const commands: Record<keyof typeof allHandlers, Command> = {
  run: { kind: 'run', source: 'github', id: '42', parent: false, gcBefore: false, egress: false, repoPath: '/repo', concurrency: 2 },
  watch: { kind: 'watch', source: 'github', repoPath: '/repo', concurrency: 2, intervalMs: 60000, once: false, egress: false },
  doctor: { kind: 'doctor', source: 'github', repoPath: '/repo' },
  'doctor-prs': { kind: 'doctor-prs', repoSlug: 'o/r', repoPath: '/repo', label: 'l', reviewingLabel: 'ri', reviewedLabel: 'rd' },
  'review-pr': { kind: 'review-pr', prRef: '1', repoPath: '/repo', egress: false },
  research: { kind: 'research', issueRef: '1', repoPath: '/repo', egress: false },
  'revise-pr': { kind: 'revise-pr', prRef: '1', repoPath: '/repo', egress: false },
  'watch-prs': { kind: 'watch-prs', repoSlug: 'o/r', repoPath: '/repo', label: 'l', reviewingLabel: 'ri', reviewedLabel: 'rd', concurrency: 2, intervalMs: 60000, once: false, egress: false },
  'review-mr': { kind: 'review-mr', iid: 1, project: 'g/p', repoPath: '/repo', egress: false },
  'watch-mrs': { kind: 'watch-mrs', project: 'g/p', repoPath: '/repo', label: 'l', reviewingLabel: 'ri', reviewedLabel: 'rd', concurrency: 2, intervalMs: 60000, once: false, egress: false },
  'doctor-mrs': { kind: 'doctor-mrs', project: 'g/p', repoPath: '/repo', label: 'l', reviewingLabel: 'ri', reviewedLabel: 'rd' },
  eval: { kind: 'eval', json: false, suggest: false, repoPath: '/repo' },
  stats: { kind: 'stats', repoPath: '/repo', json: false },
  memory: { kind: 'memory', repoPath: '/repo', json: false },
  gc: { kind: 'gc', repoPath: '/repo', maxAgeMs: 1000, dryRun: false, abandoned: false },
};

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ['node', 'vanguard'];
  process.exitCode = undefined;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

async function dispatch(command: Command): Promise<void> {
  vi.mocked(parseCli).mockReturnValue(command);
  vi.resetModules();
  await import('./index.js');
  await vi.waitFor(() => {
    if (exitSpy.mock.calls.length > 0) throw new Error(`process.exit called: ${JSON.stringify(exitSpy.mock.calls)}`);
  });
}

describe('CLI dispatch', () => {
  for (const kind of Object.keys(allHandlers) as Array<keyof typeof allHandlers>) {
    it(`routes kind "${kind}" to its handler and no other handler`, async () => {
      const command = commands[kind];
      await dispatch(command);
      await vi.waitFor(() => expect(allHandlers[kind]).toHaveBeenCalledTimes(1));
      expect(allHandlers[kind]).toHaveBeenCalledWith(command);
      for (const [otherKind, handler] of Object.entries(allHandlers)) {
        if (otherKind === kind) continue;
        expect(handler).not.toHaveBeenCalled();
      }
    });
  }

  it('gc fallthrough logs a reap summary after invoking runGc', async () => {
    await dispatch(commands.gc);
    await vi.waitFor(() => expect(runGc).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalled());
    expect(logSpy.mock.calls[0]?.[0]).toContain('Reaped');
  });

  it('"help" kind prints USAGE, calls no handler, and leaves the exit code unchanged', async () => {
    await dispatch({ kind: 'help' });
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(USAGE));
    for (const handler of Object.values(allHandlers)) expect(handler).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('"error" kind writes to stderr with a "vanguard:" prefix, sets exitCode 1, and calls no handler', async () => {
    await dispatch({ kind: 'error', message: 'boom' });
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('vanguard: boom'));
    for (const handler of Object.values(allHandlers)) expect(handler).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('an unrecognised command name parses to "help" (exit unchanged), distinct from a validation "error" (exit 1)', async () => {
    await dispatch({ kind: 'help' });
    expect(process.exitCode).toBeUndefined();

    await dispatch({ kind: 'error', message: 'run requires exactly one source' });
    expect(process.exitCode).toBe(1);
  });
});
