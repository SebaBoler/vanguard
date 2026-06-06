import { AgentError } from '../core/errors.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
}

function buildArgs(input: AgentRunInput): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
  if (input.effort !== undefined) args.push('--effort', input.effort);
  if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns));
  if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd));
  if (input.resumeSessionId !== undefined) args.push('--resume', input.resumeSessionId);
  if (input.forkSession === true) args.push('--fork-session');
  if (input.systemPrompt !== undefined) args.push('--append-system-prompt', input.systemPrompt);
  if (input.mcpConfig !== undefined) args.push('--mcp-config', input.mcpConfig, '--strict-mcp-config');
  if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
    args.push('--allowed-tools', ...input.allowedTools);
  }
  if (input.model !== undefined) args.push('--model', input.model);
  return args;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function toUsage(raw: StreamMessage['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
  };
}

function assistantText(msg: StreamMessage): string {
  return (msg.message?.content ?? [])
    .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('');
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const command = `claude ${buildArgs(input).map(shellQuote).join(' ')}`;
    const res = await input.sandbox.exec(command, {
      cwd: input.workdir,
      input: input.prompt,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let sessionId: string | undefined = input.resumeSessionId;
    let finalText = '';
    let turns = 0;
    let usage: AgentUsage | undefined;
    let costUsd: number | undefined;
    let sawResult = false;
    let parsedAny = false;

    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(trimmed) as StreamMessage;
      } catch {
        continue; // skip non-JSON diagnostic lines
      }
      parsedAny = true;
      if (msg.session_id !== undefined) sessionId = msg.session_id;
      if (msg.type === 'assistant') {
        const text = assistantText(msg);
        if (text !== '') {
          turns += 1;
          finalText = text;
          yield sessionId !== undefined ? { text, sessionId } : { text };
        }
      } else if (msg.type === 'result') {
        sawResult = true;
        if (typeof msg.result === 'string') finalText = msg.result;
        usage = toUsage(msg.usage);
        if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
      }
    }

    // Only a genuine crash (no result produced) is an error. The CLI returns a non-zero exit code
    // for graceful stops too (max_turns, max_budget), so do not treat exit code alone as failure.
    const detail = (): string => (res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(-600));
    if (!parsedAny) throw new AgentError(`Agent produced no parseable output (exit ${res.exitCode}): ${detail()}`);
    if (!sawResult) throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);

    const output: AgentRunOutput = { finalText, turns };
    if (sessionId !== undefined) output.sessionId = sessionId;
    if (usage !== undefined) output.usage = usage;
    if (costUsd !== undefined) output.costUsd = costUsd;
    return output;
  }
}
