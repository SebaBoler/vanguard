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

export interface ActiveRun {
  taskId: string;
  sessionFile: string;
  lastActivityMs: number;
}

export interface TranscriptEntry {
  role: 'assistant' | 'tool';
  text: string;
}

export interface SessionRead {
  entries: TranscriptEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Live spend estimate in USD (priced per-message off each message's model; unknown models add
   * nothing, so it's a lower bound — show as "~$"). */
  estCostUsd: number;
}

export interface Task {
  id: string;
  title: string;
  column: string;
  state: string;
}

export interface AppConfig {
  source?: string;
  label?: string;
  team?: string;
  color?: string;
  provider?: string;
  reviewProvider?: string;
  verifyCmd?: string;
  concurrency?: number;
  budgetUsd?: number;
  runCommand?: string;
  /** Doc-editor chat model (Subsystem 3), e.g. `claude-sonnet-5`. Non-secret; key is env-only. */
  chatModel?: string;
  chatBaseUrl?: string;
  /**
   * Custom providers (Subsystem 6). `keyEnv` is the NAME of the host env var holding the key —
   * the key itself is never stored. Nullable: Rust's emit-all serde writes null for absent.
   * Entries may carry unknown keys at runtime (Rust round-trips them as raw JSON); this is the
   * intended shape, validated by the core loader.
   */
  customProviders?: { name: string; baseUrl: string; keyEnv: string; model?: string }[] | null;
}

export interface RemoteRun {
  id: number;
  status: string;
  conclusion: string;
  title: string;
  branch: string;
  workflow: string;
  createdAt: string;
  event: string;
  url: string;
}

export interface Project {
  path: string;
  name: string;
  runCount: number;
  taskCount: number;
  totalCostUsd: number;
  failedCount: number;
  lastRun?: string;
  runningCount: number;
  runsLast24h: number;
  color?: string;
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
