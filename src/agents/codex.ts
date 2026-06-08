import { AgentError } from '../core/errors.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import { shellQuote } from './shell.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

function buildArgs(input: AgentRunInput): string[] {
  const args = ['exec', '--json', '--sandbox', 'danger-full-access'];
  if (input.model !== undefined) args.push('-m', input.model);
  return args;
}

function toUsage(raw: CodexEvent['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadInputTokens: raw.cached_input_tokens ?? 0,
  };
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const sh = input.sandbox.exec.bind(input.sandbox);
    const execOpts = {
      cwd: input.workdir,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };

    // codex exec authenticates from the auth.json that `codex login` writes, not from the environment
    // directly. Log in with the API key first, piped from the OPENAI_API_KEY secret inside the sandbox
    // so the key never reaches the command line or process args. Best-effort: a missing or invalid key
    // surfaces as an auth failure on the exec below, caught by the graceful-exit guard.
    await sh('printf %s "$OPENAI_API_KEY" | codex login --with-api-key', execOpts);

    const args = buildArgs(input);
    args.push(input.prompt);
    const command = `codex ${args.map(shellQuote).join(' ')}`;

    const res = await sh(command, execOpts);

    let sessionId: string | undefined;
    let finalText = '';
    let turns = 0;
    let usage: AgentUsage | undefined;
    let sawTurnCompleted = false;
    let parsedAny = false;

    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed) as CodexEvent;
      } catch {
        continue;
      }
      parsedAny = true;

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        const text = event.item.text;
        if (text !== '') {
          turns += 1;
          finalText = text;
          yield sessionId !== undefined ? { text, sessionId } : { text };
        }
      } else if (event.type === 'turn.completed') {
        sawTurnCompleted = true;
        usage = toUsage(event.usage);
      }
    }

    const detail = (): string => (res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(-600));
    if (!parsedAny) {
      throw new AgentError(`Agent produced no parseable output (exit ${res.exitCode}): ${detail()}`);
    }
    if (!sawTurnCompleted) {
      throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);
    }

    const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
    if (sessionId !== undefined) output.sessionId = sessionId;
    if (usage !== undefined) output.usage = usage;
    return output;
  }
}
