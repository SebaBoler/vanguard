import type { AgentAuth } from '../agents/auth.js';

/** One doc-chat completion request (the JSON `vanguard __complete` reads on stdin). */
export interface CompleteRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

/** The single JSON line `vanguard __complete` writes to stdout. */
export interface CompleteResponse {
  text?: string;
  error?: { message: string };
}

/** Minimal structural shape of the Anthropic client this uses (the real SDK client is cast to it). */
export interface AnthropicLike {
  messages: { create: (body: unknown) => Promise<{ content: { type: string; text?: string }[] }> };
}

/** Injected so tests mock the SDK + env auth; the CLI branch wires the real ones. */
export interface CompleteDeps {
  authFromEnv: () => AgentAuth | undefined;
  anthropic: (opts: { apiKey: string; baseURL?: string }) => AnthropicLike;
}

const NEED_KEY = 'doc chat needs ANTHROPIC_API_KEY';

/**
 * Run one plain Messages-API completion for the doc-editor chat. No sandbox, no pipeline. Requires
 * an API key (`mode:'api'`) — a Claude-Code subscription token is scoped to the CLI and rejected by
 * the Messages endpoint, so it fails fast with a specific message rather than a raw 401.
 */
export async function runComplete(req: unknown, deps: CompleteDeps): Promise<CompleteResponse> {
  const parsed = validate(req);
  if ('error' in parsed) return parsed;

  const auth = deps.authFromEnv();
  if (auth === undefined) return { error: { message: `${NEED_KEY} (none found in the environment)` } };
  if (auth.mode !== 'api') {
    return { error: { message: `${NEED_KEY} (found a Claude-Code subscription token, which the Messages API cannot use)` } };
  }

  try {
    // Construct inside the try: a bad baseURL/opts throwing synchronously becomes {error}, not a
    // reject that Rust would report as the generic "produced no output".
    const client = deps.anthropic({ apiKey: auth.apiKey, ...(parsed.baseUrl !== undefined ? { baseURL: parsed.baseUrl } : {}) });
    const res = await client.messages.create({
      model: parsed.model,
      max_tokens: parsed.maxTokens ?? 4096,
      ...(parsed.system !== undefined ? { system: parsed.system } : {}),
      messages: parsed.messages,
    });
    const text = res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return { text };
  } catch (err) {
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

function validate(req: unknown): CompleteRequest | { error: { message: string } } {
  if (req === null || typeof req !== 'object') return { error: { message: 'invalid request' } };
  const r = req as Record<string, unknown>;
  if (typeof r['model'] !== 'string' || r['model'] === '') return { error: { message: 'missing model' } };
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
    model: r['model'],
    messages: r['messages'] as CompleteRequest['messages'],
    ...(typeof r['system'] === 'string' ? { system: r['system'] } : {}),
    ...(typeof r['baseUrl'] === 'string' ? { baseUrl: r['baseUrl'] } : {}),
    ...(typeof r['maxTokens'] === 'number' ? { maxTokens: r['maxTokens'] } : {}),
  };
}
