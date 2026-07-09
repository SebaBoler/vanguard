import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KINDS } from '../evals/types.js';
import type { RetrospectiveReport } from '../core/retrospective-memory.js';
import { suggestEvalCases, renderCandidatesMarkdown, evalSuggestCommand } from './eval-suggest.js';

const FIXTURE_REPORT: RetrospectiveReport = {
  entries: [
    { kind: 'failed_run', taskId: 'TES-1', timestamp: '2026-06-06T10:00:00.000Z', detail: 'exitReason: error' },
    { kind: 'failed_proof', taskId: 'TES-2', timestamp: '2026-06-05T10:00:00.000Z', detail: 'command: pnpm test | exitCode: 1 | output: FAIL' },
    { kind: 'reviewer_note', taskId: 'TES-3', timestamp: '2026-06-04T10:00:00.000Z', detail: 'Missing error handling on the retry path' },
  ],
};

describe('suggestEvalCases', () => {
  it('maps each retrospective kind to a candidate with the expected shape', () => {
    const candidates = suggestEvalCases(FIXTURE_REPORT);
    expect(candidates).toHaveLength(3);

    const [run, proof, reviewer] = candidates;
    expect(run!.case.kind).toBe('control');
    expect(proof!.case.kind).toBe('edge');
    expect(reviewer!.case.kind).toBe('edge');

    for (const candidate of candidates) {
      expect(candidate.case.id.startsWith('draft-')).toBe(true);
      expect(candidate.case.expectation?.trim().length ?? 0).toBeGreaterThan(0);
    }

    expect(run!.case.input).toContain('TES-1');
    expect(run!.case.input).toContain('exitReason: error');
    expect(run!.reason).toBe('exitReason: error');

    expect(candidates.some((c) => c.case.kind === 'refusal')).toBe(false);
  });

  it('returns [] for an empty report without throwing', () => {
    expect(suggestEvalCases({ entries: [] })).toEqual([]);
  });

  it('is deterministic across repeated calls', () => {
    const first = suggestEvalCases(FIXTURE_REPORT);
    const second = suggestEvalCases(FIXTURE_REPORT);
    expect(second).toEqual(first);
  });

  it('disambiguates ids when taskId + timestamp collide', () => {
    const report: RetrospectiveReport = {
      entries: [
        { kind: 'failed_run', taskId: 'TES-1', timestamp: '2026-06-06T10:00:00.000Z', detail: 'first' },
        { kind: 'failed_proof', taskId: 'TES-1', timestamp: '2026-06-06T10:00:00.000Z', detail: 'second' },
      ],
    };
    const candidates = suggestEvalCases(report);
    expect(candidates[0]!.case.id).not.toBe(candidates[1]!.case.id);
  });

  it('keeps already-redacted detail intact and masks a raw long token defensively', () => {
    const rawToken = 'a'.repeat(40);
    const report: RetrospectiveReport = {
      entries: [
        { kind: 'failed_run', taskId: `TES-${rawToken}`, timestamp: '2026-06-06T10:00:00.000Z', detail: 'already redacted: ***' },
      ],
    };
    const [candidate] = suggestEvalCases(report);
    expect(candidate!.case.input).toContain('***');
    expect(candidate!.case.input).not.toContain(rawToken);
    expect(candidate!.reason).not.toContain(rawToken);
    expect(candidate!.case.id).not.toContain(rawToken);
  });

  it('every candidate satisfies corpus invariants (kind, non-empty input/expectation)', () => {
    for (const candidate of suggestEvalCases(FIXTURE_REPORT)) {
      expect(KINDS).toContain(candidate.case.kind);
      expect(candidate.case.input.trim().length).toBeGreaterThan(0);
      if (candidate.case.kind === 'control' || candidate.case.kind === 'edge') {
        expect((candidate.case.expectation ?? '').trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('renderCandidatesMarkdown', () => {
  it('shows an empty-state message for no candidates', () => {
    const markdown = renderCandidatesMarkdown([]);
    expect(markdown).toContain('DRAFT');
    expect(markdown).toContain('_No retrospective entries to draft candidates from._');
  });

  it('renders id, kind, source, input, expectation, and reason per candidate', () => {
    const candidates = suggestEvalCases(FIXTURE_REPORT);
    const markdown = renderCandidatesMarkdown(candidates);
    expect(markdown).toContain('# Eval Candidates (DRAFT — not committed to the corpus)');
    for (const candidate of candidates) {
      expect(markdown).toContain(candidate.case.id);
      expect(markdown).toContain(candidate.source);
    }
  });
});

describe('evalSuggestCommand', () => {
  const tmps: string[] = [];

  afterEach(async () => {
    for (const tmp of tmps.splice(0)) {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  async function makeTmp(): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), 'vg-eval-suggest-'));
    tmps.push(tmp);
    return tmp;
  }

  async function withLogCapture(fn: () => Promise<void>): Promise<string[]> {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await fn();
    } finally {
      console.log = origLog;
    }
    return logs;
  }

  it('emits JSON candidates for a seeded failure', async () => {
    const tmp = await makeTmp();
    const runsDir = join(tmp, '.vanguard', 'runs');
    await mkdir(runsDir, { recursive: true });
    const line = JSON.stringify({ evt: 'run_complete', ts: '2026-06-06T10:00:00.000Z', taskId: 'TES-1', exitReason: 'error' });
    await writeFile(join(runsDir, 'metrics.jsonl'), line + '\n', 'utf8');

    const logs = await withLogCapture(() =>
      evalSuggestCommand({ kind: 'eval', json: true, suggest: true, repoPath: tmp }),
    );

    const parsed = JSON.parse(logs[0]!) as Array<{ case: { id: string }; source: string }>;
    expect(parsed.some((c) => c.case.id.includes('tes-1'))).toBe(true);
  });

  it('prints the empty-state message and does not throw for a repo with no .vanguard/', async () => {
    const tmp = await makeTmp();
    const logs = await withLogCapture(() =>
      evalSuggestCommand({ kind: 'eval', json: false, suggest: true, repoPath: tmp }),
    );
    expect(logs.join('\n')).toContain('_No retrospective entries to draft candidates from._');
  });

  it('never writes to src/evals/corpus/, and refuses an --out path under it', async () => {
    const tmp = await makeTmp();
    const corpusDir = join(process.cwd(), 'src', 'evals', 'corpus');
    const before = await readFile(join(corpusDir, 'index.ts'), 'utf8');

    await withLogCapture(() => evalSuggestCommand({ kind: 'eval', json: false, suggest: true, repoPath: tmp }));

    const after = await readFile(join(corpusDir, 'index.ts'), 'utf8');
    expect(after).toBe(before);

    await expect(
      withLogCapture(() =>
        evalSuggestCommand({
          kind: 'eval',
          json: false,
          suggest: true,
          repoPath: tmp,
          out: join(corpusDir, 'sneaky.ts'),
        }),
      ),
    ).rejects.toThrow(/suggest-only/);
  });

  it('writes drafts to a scratch --out path', async () => {
    const tmp = await makeTmp();
    const outPath = join(tmp, '.vanguard', 'memory', 'eval-candidates.md');

    await withLogCapture(() =>
      evalSuggestCommand({ kind: 'eval', json: false, suggest: true, repoPath: tmp, out: outPath }),
    );

    await expect(access(outPath)).resolves.toBeUndefined();
    const written = await readFile(outPath, 'utf8');
    expect(written).toContain('DRAFT');
  });
});
