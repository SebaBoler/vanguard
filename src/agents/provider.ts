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
  systemPrompt?: string;
  mcpConfig?: string;
  allowedTools?: string[];
  model?: string;
  /** Per-invocation env overlaid on the sandbox env (e.g. per-stage transport: ANTHROPIC_BASE_URL + nonce). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/** Fraction of input tokens served from cache (0..1); a proxy for prompt-cache effectiveness. */
export function cacheEfficiency(usage: AgentUsage): number {
  const total = usage.inputTokens + usage.cacheReadInputTokens;
  return total === 0 ? 0 : usage.cacheReadInputTokens / total;
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
  /** Raw agent output (e.g. the stream-json), persisted as the run transcript. */
  transcript?: string;
}

export interface AgentProvider {
  readonly name: string;
  /** Run one agent invocation inside the sandbox; yields assistant turns, returns a summary. */
  run: (input: AgentRunInput) => AsyncGenerator<AgentTurn, AgentRunOutput, void>;
}
