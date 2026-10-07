import { describe, it, expect } from 'vitest';
import { decisionJudge, decisionDiffScorer } from './decision-judge.js';
import type { EvalCase } from './types.js';
import type { RunResult } from '../core/types.js';

const cfg = { url: 'https://example.test/run', model: 'clef-flash' };
const testCase: EvalCase = { id: 'c1', kind: 'control', input: 'do x', expectation: 'x done' };
const runResult = { taskId: 't', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/w', worktreePreserved: false, finalText: '' } as RunResult;

function answering(answers: unknown, record: { state?: unknown; questions?: Record<string, { type: string }> } = {}): typeof fetch {
  return (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { state: unknown; questions: Record<string, { type: string }> };
    record.state = body.state;
    record.questions = body.questions;
    return new Response(JSON.stringify({ model: 'clef-flash', answers, usage: { input_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
}

describe('decisionJudge', () => {
  it('maps P(acceptable) to passed/score and names the quality level in the reason', async () => {
    const record: { state?: unknown; questions?: Record<string, { type: string }> } = {};
    const judge = decisionJudge(cfg, { fetchImpl: answering({ acceptable: { type: 'noul', noul: 0.82 }, quality: { type: 'score', score: 2.6, confidence: 0.7 } }, record) });
    const v = await judge.judge({ testCase, output: 'done x' });
    expect(v).toEqual({ passed: true, score: 0.82, reason: 'clef-flash: P(acceptable)=0.82, quality Good (2.60/4)' });
    expect(record.state).toMatchObject({ case_kind: 'control', input: 'do x', expectation: 'x done', agent_output: 'done x' });
    expect(record.questions?.['acceptable']?.type).toBe('noul');
    expect(record.questions?.['quality']?.type).toBe('score');
  });

  it('fails the case below 0.5 and throws when the model gives no answer (an eval must not silently pass)', async () => {
    const low = decisionJudge(cfg, { fetchImpl: answering({ acceptable: { noul: 0.2 } }) });
    expect((await low.judge({ testCase, output: 'nope' })).passed).toBe(false);
    const missing = decisionJudge(cfg, { fetchImpl: answering({ quality: { score: 3 } }) });
    await expect(missing.judge({ testCase, output: 'x' })).rejects.toThrow(/no "acceptable" answer/);
    const dead = decisionJudge(cfg, { fetchImpl: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch });
    await expect(dead.judge({ testCase, output: 'x' })).rejects.toThrow(/no verdict for case c1/);
  });
});

describe('decisionDiffScorer', () => {
  it('scores a diff by P(acceptable) with the run summary and file list placed before the diff', async () => {
    const record: { state?: unknown } = {};
    const score = decisionDiffScorer(cfg, { fetchImpl: answering({ acceptable: { noul: 0.64 }, quality: { score: 2.1 } }, record) });
    const v = await score('--- a/src/a.ts\n+++ b/src/a.ts\n+ real change', runResult);
    expect(v.score).toBe(0.64);
    expect(v.passed).toBe(true);
    expect(Object.keys(record.state as object)).toEqual(['implementer_completed', 'implementer_exit_reason', 'files', 'diff']);
    expect(record.state).toMatchObject({ implementer_completed: true, implementer_exit_reason: 'completed', files: ['src/a.ts'] });
  });

  it('labels an empty diff and sends head + tail of an oversized one with the note ahead of the diff', async () => {
    const record: { state?: unknown } = {};
    const score = decisionDiffScorer(cfg, { fetchImpl: answering({ acceptable: { noul: 0.01 }, quality: { score: 0 } }, record) });
    await score('', runResult);
    expect((record.state as { diff: string }).diff).toBe('(empty diff — no changes)');
    const big = `${'h'.repeat(100_000)}${'m'.repeat(50_000)}${'t'.repeat(100_000)}`;
    await score(big, runResult);
    const state = record.state as { note?: string; diff: string };
    expect(state.note).toContain('250000 characters');
    expect(Object.keys(state).indexOf('note')).toBeLessThan(Object.keys(state).indexOf('diff'));
    expect(state.diff.startsWith('h'.repeat(60_000))).toBe(true);
    expect(state.diff.endsWith('t'.repeat(60_000))).toBe(true);
    expect(state.diff).toContain('characters omitted');
  });
});
