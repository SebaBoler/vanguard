import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider, AgentUsage } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ExitReason = 'completed' | 'incomplete' | 'maxTurns' | 'timeout' | 'error';

export interface RunOptions {
  taskId: string;
  localRepoPath: string;
  baseBranch?: string;
  promptTemplate: string;
  variables?: Record<string, string>;
  skills?: string[];
  effort?: ReasoningEffort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  resumeSessionId?: string;
  systemPrompt?: string;
  mcpConfig?: string;
  allowedTools?: string[];
  sandbox: IsolatedSandboxProvider;
  agent: AgentProvider;
  logger?: VanguardLogger;
  signal?: AbortSignal;
}

export interface RunResult {
  taskId: string;
  completed: boolean;
  exitReason: ExitReason;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  diff?: string;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
}
