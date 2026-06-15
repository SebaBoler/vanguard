// Pure rewrite/lockdown logic for the host LLM reverse-proxy sidecar.
// Authored as plain ESM `.mjs` so BOTH the strict-TS app and the zero-dep sidecar
// (`llm-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `llm-proxy-rewrite.d.mts`. The sidecar gets this file
// `docker cp`'d next to it so the relative `import './llm-proxy-rewrite.mjs'` resolves.
import { timingSafeEqual } from 'node:crypto';

export const OAUTH_BETA = 'oauth-2025-04-20';

/** Coerce a node header value (string | string[] | undefined) to a single comma-joined string. */
function betaToString(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export function mergeAnthropicBeta(incoming, extra) {
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
export function upstreamAuthHeaders(auth, reqHeaders) {
  const beta = betaToString(reqHeaders['anthropic-beta']);
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  // api mode: x-api-key, no oauth beta; pass through the request's anthropic-beta unchanged if present.
  return { 'x-api-key': auth.secret, ...(beta !== undefined ? { 'anthropic-beta': beta } : {}) };
}

// Per-upstream POST allowlists (query string ignored, no wildcards).
const ALLOWED_BY_UPSTREAM = {
  anthropic: new Set(['/v1/messages', '/v1/messages/count_tokens']),
  openai: new Set(['/v1/responses']),
};
/**
 * Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored).
 * anthropic => /v1/messages, /v1/messages/count_tokens. openai => /v1/responses only.
 */
export function isAllowedLlmPath(method, path, upstream = 'anthropic') {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  const allowed = ALLOWED_BY_UPSTREAM[upstream];
  if (allowed === undefined) return false;
  const p = (path ?? '').split('?')[0] ?? '';
  return allowed.has(p);
}

/** Headers to apply upstream for OpenAI: just Bearer SECRET (no anthropic-beta, no x-api-key). */
export function openaiAuthHeaders(secret) {
  return { authorization: `Bearer ${secret}` };
}

/** Constant-time string compare (length-safe). */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of which arg differs, then return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
