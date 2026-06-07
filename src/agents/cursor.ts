import { AgentError } from '../core/errors.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import { shellQuote, assistantText } from './shell.js';

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  finalText?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
}

function buildArgs(input: AgentRunInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--force'];
  if (input.model !== undefined) args.push('--model', input.model);
  return args;
}

function toUsage(raw: StreamMessage['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    cacheReadInputTokens: 0,
  };
}

export class CursorProvider implements AgentProvider {
  readonly name = 'cursor';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const command = `agent ${buildArgs(input).map(shellQuote).join(' ')}`;
    const res = await input.sandbox.exec(command, {
      cwd: input.workdir,
      input: input.prompt,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let sessionId: string | undefined;
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
        continue;
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
        if (typeof msg.finalText === 'string') finalText = msg.finalText;
        usage = toUsage(msg.usage);
        if (typeof msg.costUsd === 'number') costUsd = msg.costUsd;
      }
    }

    const detail = (): string => (res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(-600));
    if (!parsedAny) throw new AgentError(`Agent produced no parseable output (exit ${res.exitCode}): ${detail()}`);
    if (!sawResult) throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);

    const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
    if (sessionId !== undefined) output.sessionId = sessionId;
    if (usage !== undefined) output.usage = usage;
    if (costUsd !== undefined) output.costUsd = costUsd;
    return output;
  }
}
