import { AgentError } from '../core/errors.js';
import type { AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import { shellQuote, assistantText } from './shell.js';

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: Array<{ type?: string; text?: string }>; model?: string };
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
}

function toUsage(raw: StreamMessage['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
  };
}

/**
 * Run the in-sandbox `claude` CLI (stream-json) with the given arg list and parse its NDJSON event
 * stream into assistant turns + a run summary. Shared by ClaudeCodeProvider (Anthropic) and ZaiProvider
 * (z.ai GLM, which reuses the same Claude Code CLI pointed at z.ai's Anthropic-compatible endpoint).
 *
 * The caller owns arg construction (effort, model, mcp, etc.); this function owns the prompt-feeding,
 * stream parsing, and the graceful-exit invariant (only a genuine crash with no `result` event is an
 * error — the CLI returns non-zero for graceful stops like max_turns/max_budget too).
 */
export async function* runClaudeCli(
  input: AgentRunInput,
  buildArgs: (input: AgentRunInput) => string[],
): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
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
  let model: string | undefined;
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
    if (typeof msg.model === 'string') model = msg.model;
    else if (typeof msg.message?.model === 'string') model = msg.message.model;
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
  if (!sawResult) {
    // A missing terminal `result` event after real work already streamed (assistant turns + a session id)
    // and a clean exit is a truncated/cut stream — a long SSE severed by a corp MITM proxy, or the CLI
    // stopping without its summary — NOT a crash. Salvage the turns so the stage lands as `incomplete` and
    // the resume loop can continue the SAME session, instead of throwing away an expensive run. A non-zero
    // exit, zero turns, or no session id (nothing to resume) stays a genuine crash.
    if (res.exitCode !== 0 || turns === 0 || sessionId === undefined) {
      throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);
    }
    console.warn(
      `vanguard: claude stream ended without a result event (exit 0, ${turns} turns) — treating the stage as incomplete and resumable`,
    );
  }

  const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
  if (sessionId !== undefined) output.sessionId = sessionId;
  if (usage !== undefined) output.usage = usage;
  if (costUsd !== undefined) output.costUsd = costUsd;
  if (model !== undefined) output.model = model;
  return output;
}
