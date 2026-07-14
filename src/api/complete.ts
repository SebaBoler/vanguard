// CompleteRequest/CompleteResponse live in src/wire.ts (the shared desktop contract — S7).
export type { CompleteRequest, CompleteResponse } from '../wire.js';
import type { CompleteRequest, CompleteResponse } from '../wire.js';

/** The async-iterable subset of the agent SDK's `query()` result we consume. */
type QueryStream = AsyncIterable<{ type: string; subtype?: string; result?: string }>;

/** Injected so tests mock the SDK; the CLI branch wires the real `@anthropic-ai/claude-agent-sdk`. */
export interface CompleteDeps {
  query: (params: { prompt: string; options?: Record<string, unknown> }) => QueryStream;
}

/**
 * Run one plain doc-editor chat completion via the Claude Code agent SDK. Auth is inherited from the
 * environment exactly like the `claude` CLI — so a `CLAUDE_CODE_OAUTH_TOKEN` subscription token works
 * with no API key (and `ANTHROPIC_API_KEY` works too). No tools are allowed, so it behaves as a
 * completion, not an agent (no filesystem/tool access); the turn cap is only a runaway stop.
 */
export async function runComplete(req: unknown, deps: CompleteDeps): Promise<CompleteResponse> {
  const parsed = validate(req);
  if ('error' in parsed) return parsed;

  const prompt = parsed.messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  try {
    const stream = deps.query({
      prompt,
      options: {
        allowedTools: [], // completion, not an agent — no filesystem/tool access
        settingSources: [], // don't load project/user CLAUDE.md or settings
        // NOT 1 (dogfood 2026-07-14): the SDK counts internal assistant steps (thinking, a
        // hallucinated tool call it then refuses) as turns, so maxTurns:1 intermittently dies
        // with error_max_turns before any text lands. With zero tools allowed the extra turns
        // can't act — this stays a completion, the cap is only a runaway stop.
        maxTurns: 8,
        ...(parsed.system !== undefined ? { systemPrompt: parsed.system } : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.baseUrl !== undefined ? { env: withBaseUrl(parsed.baseUrl) } : {}),
      },
    });
    for await (const msg of stream) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && typeof msg.result === 'string') return { text: msg.result };
        return { error: { message: `doc chat failed: ${msg.subtype ?? 'unknown error'}` } };
      }
    }
    return { error: { message: 'no result from the model' } };
  } catch (err) {
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Preserve the inherited env (incl. the auth token) and point the SDK at a custom Anthropic-compatible base URL. */
function withBaseUrl(baseUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env['ANTHROPIC_BASE_URL'] = baseUrl;
  return env;
}

function validate(req: unknown): CompleteRequest | { error: { message: string } } {
  if (req === null || typeof req !== 'object') return { error: { message: 'invalid request' } };
  const r = req as Record<string, unknown>;
  if (!Array.isArray(r['messages']) || r['messages'].length === 0) {
    return { error: { message: 'messages must be a non-empty array' } };
  }
  for (const m of r['messages'] as unknown[]) {
    if (m === null || typeof m !== 'object') return { error: { message: 'each message must be an object' } };
    const role = (m as Record<string, unknown>)['role'];
    const content = (m as Record<string, unknown>)['content'];
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return { error: { message: 'each message needs role user|assistant and string content' } };
    }
  }
  return {
    messages: r['messages'] as CompleteRequest['messages'],
    ...(typeof r['system'] === 'string' ? { system: r['system'] } : {}),
    ...(typeof r['model'] === 'string' ? { model: r['model'] } : {}),
    ...(typeof r['baseUrl'] === 'string' ? { baseUrl: r['baseUrl'] } : {}),
  };
}
