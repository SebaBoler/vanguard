// Pure rewrite/lockdown logic for the host LLM reverse-proxy sidecar.
// The zero-dep sidecar `llm-proxy-server.mjs` reimplements these semantics inline;
// keep auth/beta/path semantics in sync between the two files.
import { timingSafeEqual } from 'node:crypto';

export type UpstreamAuth = { mode: 'subscription'; secret: string } | { mode: 'api'; secret: string };
export const OAUTH_BETA = 'oauth-2025-04-20';

/** Coerce a node header value (string | string[] | undefined) to a single comma-joined string. */
function betaToString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export function mergeAnthropicBeta(incoming: string | string[] | undefined, extra: string): string {
  const parts = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!parts.includes(extra)) parts.push(extra);
  return parts.join(',');
}

/**
 * Headers to apply upstream for the chosen auth mode. Returns lowercase keys to set; caller deletes any
 * conflicting inbound auth headers first. Subscription => Authorization: Bearer + oauth beta merged;
 * api => x-api-key, no oauth beta.
 */
export function upstreamAuthHeaders(
  auth: UpstreamAuth,
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const beta = betaToString(reqHeaders['anthropic-beta']);
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  // api mode: x-api-key, no oauth beta; pass through the request's anthropic-beta unchanged if present.
  return { 'x-api-key': auth.secret, ...(beta !== undefined ? { 'anthropic-beta': beta } : {}) };
}

const ALLOWED = new Set(['/v1/messages', '/v1/messages/count_tokens']);
/** Only POST to the two Claude Code messages endpoints (query string ignored). */
export function isAllowedLlmPath(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const p = path.split('?')[0] ?? '';
  return ALLOWED.has(p);
}

/** Constant-time string compare (length-safe). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of which arg differs, then return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
