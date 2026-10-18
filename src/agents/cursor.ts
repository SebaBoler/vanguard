import { AgentError } from '../core/errors.js';
import { redactTokens } from '../core/secret-scan.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from './provider.js';
import { shellQuote, assistantText } from './shell.js';

/**
 * One NDJSON line of `agent -p --output-format stream-json` (cursor.com/docs/cli/reference/output-format):
 * `system/init` (session_id, model display name), `user`, one `assistant` per text segment between tool
 * calls, `tool_call` started/completed, and a terminal `result`. The stream carries no token usage or
 * cost, so this provider reports neither.
 */
interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  is_error?: boolean;
  result?: string;
}

/**
 * Claude CLI aliases and Anthropic ids that Vanguard's stage presets pin (spec → `haiku`, plan →
 * `opus`, escalation → `claude-fable-5-1`). Cursor names its models differently, so these are dropped
 * and the account's default model runs. Any other id is passed through as given.
 */
// ponytail: drop, not map; add a Claude → Cursor id map once `agent models` output is pinned down.
const CLAUDE_MODEL = /^(?:haiku|sonnet|opus|fable)$|^claude-(?:haiku|sonnet|opus|fable)-/;

function buildArgs(input: AgentRunInput): string[] {
  // --trust: headless runs cannot answer the workspace-trust prompt. --sandbox disabled: the Vanguard
  // container is the boundary (like codex's danger-full-access); Cursor's own sandbox is not set up there.
  const args = ['-p', '--output-format', 'stream-json', '--force', '--trust', '--sandbox', 'disabled'];
  if (input.model !== undefined && !CLAUDE_MODEL.test(input.model)) args.push('--model', input.model);
  // A pipeline resume (repair gate, spec nudge) runs in the same sandbox, where the chat is still on disk.
  if (input.resumeSessionId !== undefined) args.push('--resume', input.resumeSessionId);
  return args;
}

export class CursorProvider implements AgentProvider {
  readonly name = 'cursor';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    // The prompt goes on stdin, never argv: `sh -lc` puts the whole command in one argv string, which
    // Linux caps at 128 KiB (see codex.ts). Cursor has no system-prompt flag, so it leads the prompt.
    const prompt = input.systemPrompt !== undefined ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
    const command = `agent ${buildArgs(input).map(shellQuote).join(' ')}`;
    const res = await input.sandbox.exec(command, {
      cwd: input.workdir,
      input: prompt,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    let sessionId: string | undefined;
    let finalText = '';
    let turns = 0;
    let model: string | undefined;
    let result: StreamMessage | undefined;
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
      if (msg.type === 'system' && typeof msg.model === 'string') model = msg.model;
      if (msg.type === 'assistant') {
        const text = assistantText(msg);
        if (text !== '') {
          turns += 1;
          finalText = text;
          yield sessionId !== undefined ? { text, sessionId } : { text };
        }
      } else if (msg.type === 'result') {
        result = msg;
      }
    }

    // Masked like codex.ts: this text reaches the run log and the issue comment, and cursor's key is
    // injected straight into the sandbox, so raw stderr/stdout could carry it.
    const detail = (): string => {
      const err = redactTokens(res.stderr.trim());
      const out = redactTokens(res.stdout.trim()).slice(-1500);
      return [err !== '' ? `stderr: ${err}` : '', out !== '' ? `stdout: ${out}` : ''].filter(Boolean).join(' | ') || '(no output)';
    };
    if (!parsedAny) throw new AgentError(`Agent produced no parseable output (exit ${res.exitCode}): ${detail()}`);
    if (result === undefined) throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);
    if (result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success')) {
      throw new AgentError(`Agent reported an error result (${result.subtype ?? 'is_error'}, exit ${res.exitCode}): ${detail()}`);
    }
    // `result.result` concatenates every segment with no separator, so the last segment is the real final
    // message (where the termination signal sits); fall back to it only when no segment was streamed.
    if (finalText === '' && typeof result.result === 'string') finalText = result.result;

    const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
    if (sessionId !== undefined) output.sessionId = sessionId;
    if (model !== undefined) output.model = model;
    return output;
  }
}
