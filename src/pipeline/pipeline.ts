import type { RunResult } from '../core/types.js';

export interface StageContext {
  taskId: string;
  variables: Record<string, string>;
  previous?: RunResult;
}

export interface StageResult {
  name: string;
  result: RunResult;
}

/**
 * One step of the Implement -> Review -> Simplify -> Merge pipeline. Phase-2 impl:
 * each stage is a vanguard.run() over a shared worktree+sandbox, chained by resuming
 * or forking the prior session (the Reviewer reads the previous RunResult.diff).
 */
export interface Stage {
  name: string;
  run: (context: StageContext) => Promise<StageResult>;
}

export interface Pipeline {
  stages: Stage[];
  run: (taskId: string, variables: Record<string, string>) => Promise<StageResult[]>;
}
