import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCli } from './args.js';
import { JUDGE_MODEL, DEFAULT_PRODUCE_MODEL } from '../evals/corpus/index.js';
import { evalCommand } from './eval.js';

describe('parseCli eval', () => {
  it('parses eval with defaults', () => {
    const cmd = parseCli(['eval'], '/repo');
    expect(cmd).toEqual({ kind: 'eval', json: false });
  });

  it('parses --json flag', () => {
    const cmd = parseCli(['eval', '--json'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', json: true });
  });

  it('parses --judge-model override', () => {
    const cmd = parseCli(['eval', '--judge-model', 'claude-opus-4-8'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', judgeModel: 'claude-opus-4-8' });
  });

  it('parses --produce-model override', () => {
    const cmd = parseCli(['eval', '--produce-model', 'claude-sonnet-4-6'], '/repo');
    expect(cmd).toMatchObject({ kind: 'eval', produceModel: 'claude-sonnet-4-6' });
  });

});

describe('JUDGE_MODEL', () => {
  it('is pinned to the expected Haiku-class model id', () => {
    expect(JUDGE_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('differs from DEFAULT_PRODUCE_MODEL to prevent self-judging', () => {
    expect(JUDGE_MODEL).not.toBe(DEFAULT_PRODUCE_MODEL);
  });
});

describe('evalCommand', () => {
  const fakeVerdictResponse = '<verdict>{"passed":true,"score":1,"reason":"ok"}</verdict>';

  function makeTestFactory(recordedModels: string[]) {
    return (model: string) => {
      recordedModels.push(model);
      return async (_prompt: string): Promise<string> => fakeVerdictResponse;
    };
  }

  it('passes JUDGE_MODEL to the judge and DEFAULT_PRODUCE_MODEL to produce by default', async () => {
    const models: string[] = [];
    const cmd = { kind: 'eval' as const, json: false };
    await evalCommand(cmd, makeTestFactory(models));
    expect(models).toHaveLength(2);
    expect(models).toContain(JUDGE_MODEL);
    expect(models).toContain(DEFAULT_PRODUCE_MODEL);
  });

  it('respects a --judge-model override', async () => {
    const models: string[] = [];
    const cmd = { kind: 'eval' as const, json: false, judgeModel: 'claude-opus-4-8' };
    await evalCommand(cmd, makeTestFactory(models));
    expect(models).toContain('claude-opus-4-8');
    expect(models).not.toContain(JUDGE_MODEL);
  });

  it('respects a --produce-model override', async () => {
    const models: string[] = [];
    const cmd = {
      kind: 'eval' as const,
      json: false,
      produceModel: 'claude-opus-4-8',
    };
    await evalCommand(cmd, makeTestFactory(models));
    expect(models).toContain('claude-opus-4-8');
  });

  it('emits a JSON EvalReport when --json is set', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: true };
      await evalCommand(cmd, makeTestFactory([]));
      const call = logSpy.mock.calls[0];
      expect(call).toBeDefined();
      const parsed = JSON.parse(call![0] as string);
      expect(parsed).toHaveProperty('total');
      expect(parsed).toHaveProperty('passRate');
      expect(parsed).toHaveProperty('byKind');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints a formatted table when --json is false', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const cmd = { kind: 'eval' as const, json: false };
      await evalCommand(cmd, makeTestFactory([]));
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('EVAL RESULTS');
      expect(output).toContain('control');
      expect(output).toContain('OVERALL');
    } finally {
      logSpy.mockRestore();
    }
  });
});
