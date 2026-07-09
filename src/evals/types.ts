export const KINDS = ['control', 'edge', 'refusal'] as const;
export type EvalKind = (typeof KINDS)[number];

export interface EvalCase {
  id: string;
  kind: EvalKind;
  input: string;
  expectation?: string;
  variables?: Record<string, string>;
}

export interface EvalVerdict {
  passed: boolean;
  score: number;
  reason: string;
}

export interface EvalCaseResult {
  testCase: EvalCase;
  output: string;
  verdict: EvalVerdict;
}

export interface KindTally {
  total: number;
  passed: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byKind: Record<EvalKind, KindTally>;
  results: EvalCaseResult[];
}

export interface Judge {
  judge: (args: { testCase: EvalCase; output: string }) => Promise<EvalVerdict>;
}
