export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface RunRecord {
  taskId: string;
  completed: boolean;
  exitReason: string;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
  cacheEfficiency?: number;
  durationMs?: number;
  model?: string;
  timestamp: string;
  stage?: string;
  prUrl?: string;
}

export interface Proof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
}

export interface RunSummary {
  taskId: string;
  timestamp: string;
  stages: string[];
  totalCostUsd: number;
  anyFailed: boolean;
  prUrl?: string;
}

export interface StageDetail {
  record: RunRecord;
  diff?: string;
  transcript?: string;
}

export interface RunDetail {
  taskId: string;
  timestamp: string;
  stages: StageDetail[];
  proof?: Proof;
}
