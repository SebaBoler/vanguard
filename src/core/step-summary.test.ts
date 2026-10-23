import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendStepSummary, renderStepSummary } from './step-summary.js';
import type { StepSummary } from './step-summary.js';
import type { RunResult } from './types.js';

const baseResult: RunResult = {
  taskId: 'gh-o-r-7',
  completed: true,
  exitReason: 'completed',
  turns: 0,
  worktreePath: '/tmp/wt',
  worktreePreserved: false,
  finalText: 'done',
};

const summary: StepSummary = {
  taskId: 'o/r#7',
  flow: 'default',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  outcomes: [
    { name: 'implementer', result: { ...baseResult, turns: 12, costUsd: 1.25, durationMs: 90_000 } },
    { name: 'reviewer', result: { ...baseResult, exitReason: 'maxTurns', turns: 3, costUsd: 0.5, durationMs: 15_500 } },
  ],
  exit: 'completed',
  prUrl: 'https://github.com/o/r/pull/8',
  verdict: 'clean',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vg-step-summary-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderStepSummary', () => {
  it('renders the run header, one table row per stage, the cost total and the trailer', () => {
    const md = renderStepSummary(summary);
    expect(md).toContain('### Vanguard run `o/r#7` — completed');
    expect(md).toContain('flow `default` · provider `claude` · model `claude-sonnet-5-5`');
    expect(md).toContain('| stage | exit | turns | time | $cost |');
    expect(md).toContain('| implementer | completed | 12 | 90.0s | 1.2500 |');
    expect(md).toContain('| reviewer | maxTurns | 3 | 15.5s | 0.5000 |');
    expect(md).toContain('| **total** | | | | **1.7500** |');
    expect(md).toContain('- PR: https://github.com/o/r/pull/8');
    expect(md).toContain('- Verdict: clean');
  });

  it('says so when no stage ran and carries the error on an error exit', () => {
    const md = renderStepSummary({ taskId: 't', flow: 'default', provider: 'claude', outcomes: [], exit: 'error', error: 'boom' });
    expect(md).toContain('### Vanguard run `t` — error');
    expect(md).toContain('_no stage ran_');
    expect(md).toContain('- Error: boom');
    expect(md).not.toContain('model');
    expect(md).not.toContain('PR:');
  });

  it('T13: notes extend the trailer without altering summaries that omit them', () => {
    const plain = renderStepSummary(summary);
    expect(renderStepSummary({ ...summary, notes: [] })).toBe(plain);
    const noted = renderStepSummary({ ...summary, notes: ['ignored feedback from @mallory (NONE)'] });
    expect(noted.replace('- Note: ignored feedback from @mallory (NONE)\n', '')).toBe(plain);
  });
});

describe('appendStepSummary', () => {
  it('appends — a second run in the same job stacks under the first', async () => {
    const file = join(dir, 'summary.md');
    await appendStepSummary(file, summary);
    await appendStepSummary(file, { ...summary, taskId: 'o/r#9', exit: 'secret-blocked' });
    const text = await readFile(file, 'utf8');
    expect(text.startsWith(renderStepSummary(summary))).toBe(true);
    expect(text.indexOf('`o/r#9` — secret-blocked')).toBeGreaterThan(text.indexOf('`o/r#7` — completed'));
  });

  it('writes nothing when GITHUB_STEP_SUMMARY is unset or empty', async () => {
    await appendStepSummary(undefined, summary);
    await appendStepSummary('', summary);
    expect(await readdir(dir)).toEqual([]);
  });
});
