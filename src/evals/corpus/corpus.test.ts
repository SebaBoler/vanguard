import { describe, it, expect } from 'vitest';
import { corpus } from './index.js';
import { KINDS } from '../types.js';
const MIN_PER_KIND = 8;

describe('eval corpus invariants', () => {
  it('has unique ids across the full corpus', () => {
    const ids = corpus.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('every case has a valid kind', () => {
    for (const c of corpus) {
      expect(KINDS).toContain(c.kind);
    }
  });

  it('every case has a non-empty input', () => {
    // edge-01 has an intentionally empty input to test empty-input handling
    const nonEmptyInputCases = corpus.filter((c) => c.id !== 'edge-01');
    for (const c of nonEmptyInputCases) {
      expect(c.input.trim().length).toBeGreaterThan(0);
    }
  });

  it('control and edge cases have a non-empty expectation', () => {
    const nonRefusal = corpus.filter((c) => c.kind === 'control' || c.kind === 'edge');
    for (const c of nonRefusal) {
      expect((c.expectation ?? '').trim().length, `${c.id} missing expectation`).toBeGreaterThan(0);
    }
  });

  it(`each kind has at least ${MIN_PER_KIND} cases`, () => {
    for (const kind of KINDS) {
      const count = corpus.filter((c) => c.kind === kind).length;
      expect(count, `${kind} has ${count} cases (need ≥${MIN_PER_KIND})`).toBeGreaterThanOrEqual(MIN_PER_KIND);
    }
  });

  it('runEvals over the corpus with a stub produce+judge matches corpus.length', async () => {
    const { runEvals } = await import('../run-evals.js');
    const { programmaticJudge } = await import('../judges.js');
    const report = await runEvals({
      cases: corpus,
      produce: async (tc) => `stub output for ${tc.id}`,
      judge: programmaticJudge(() => true),
    });
    expect(report.total).toBe(corpus.length);
    expect(report.byKind.control.total).toBe(corpus.filter((c) => c.kind === 'control').length);
    expect(report.byKind.edge.total).toBe(corpus.filter((c) => c.kind === 'edge').length);
    expect(report.byKind.refusal.total).toBe(corpus.filter((c) => c.kind === 'refusal').length);
  });
});
