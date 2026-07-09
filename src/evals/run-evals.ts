import { KINDS } from './types.js';
import type { EvalCase, EvalCaseResult, EvalKind, EvalReport, Judge, KindTally } from './types.js';

export interface RunEvalsOptions {
  cases: EvalCase[];
  judge: Judge;
  /** Produce the agent's output for a case (wrap vanguard.run / runAgent here). */
  produce: (testCase: EvalCase) => Promise<string>;
}

/** Run every case through produce -> judge and aggregate a pass/fail report grouped by kind. */
export async function runEvals(opts: RunEvalsOptions): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const testCase of opts.cases) {
    const output = await opts.produce(testCase);
    const verdict = await opts.judge.judge({ testCase, output });
    results.push({ testCase, output, verdict });
  }
  const byKind = Object.fromEntries(
    KINDS.map((kind): [EvalKind, KindTally] => {
      const ofKind = results.filter((result) => result.testCase.kind === kind);
      return [kind, { total: ofKind.length, passed: ofKind.filter((result) => result.verdict.passed).length }];
    }),
  ) as Record<EvalKind, KindTally>;
  const passed = results.filter((result) => result.verdict.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    byKind,
    results,
  };
}
