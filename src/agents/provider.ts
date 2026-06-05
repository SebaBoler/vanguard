import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { ReasoningEffort } from '../core/types.js';

export interface AgentRunInput {
  prompt: string;
  sandbox: IsolatedSandboxProvider;
  workdir: string;
  home: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  forkSession?: boolean;
  signal?: AbortSignal;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface AgentTurn {
  text: string;
  sessionId?: string;
}

export interface AgentRunOutput {
  finalText: string;
  sessionId?: string;
  turns: number;
  usage?: AgentUsage;
  costUsd?: number;
}

export interface AgentProvider {
  readonly name: string;
  /** Run one agent invocation inside the sandbox; yields assistant turns, returns a summary. */
  run: (input: AgentRunInput) => AsyncGenerator<AgentTurn, AgentRunOutput, void>;
}
