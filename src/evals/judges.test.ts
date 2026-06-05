import { describe, it, expect } from 'vitest';
import { programmaticJudge, llmJudge } from './judges.js';
import type { EvalCase } from './types.js';

const testCase: EvalCase = { id: 'c1', kind: 'control', input: 'do X' };

describe('programmaticJudge', () => {
  it('turns a true predicate into a passing verdict', async () => {
    const v = await programmaticJudge(() => true).judge({ testCase, output: 'X' });
    expect(v).toEqual({ passed: true, score: 1, reason: 'OK' });
  });

  it('turns a false predicate into a failing verdict', async () => {
    const v = await programmaticJudge(() => false).judge({ testCase, output: 'Y' });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
  });

  it('passes a full verdict through unchanged', async () => {
    const verdict = { passed: true, score: 0.7, reason: 'partial' };
    const v = await programmaticJudge(() => verdict).judge({ testCase, output: 'Z' });
    expect(v).toEqual(verdict);
  });
});

describe('llmJudge', () => {
  it('parses a Zod-validated verdict from the model output', async () => {
    const complete = async (): Promise<string> => '<verdict>{"passed":true,"score":0.9,"reason":"ok"}</verdict>';
    const v = await llmJudge(complete).judge({ testCase, output: 'result' });
    expect(v).toEqual({ passed: true, score: 0.9, reason: 'ok' });
  });

  it('throws when the model omits the verdict tag', async () => {
    const complete = async (): Promise<string> => 'no verdict here';
    await expect(llmJudge(complete).judge({ testCase, output: 'result' })).rejects.toThrow();
  });
});
