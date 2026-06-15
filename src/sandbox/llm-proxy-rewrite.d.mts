// Type declarations for the plain-ESM `llm-proxy-rewrite.mjs` so the strict-TS app keeps types.
export type Upstream = 'anthropic' | 'openai';
export type UpstreamAuth = { mode: 'subscription'; secret: string } | { mode: 'api'; secret: string };

export declare const OAUTH_BETA: 'oauth-2025-04-20';

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export declare function mergeAnthropicBeta(incoming: string | string[] | undefined, extra: string): string;

/**
 * Headers to apply upstream for the chosen auth mode. Subscription => Authorization: Bearer + oauth beta
 * merged; api => x-api-key, no oauth beta.
 */
export declare function upstreamAuthHeaders(
  auth: UpstreamAuth,
  reqHeaders: Record<string, string | string[] | undefined>,
): Record<string, string>;

/**
 * Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored).
 * anthropic => /v1/messages, /v1/messages/count_tokens. openai => /v1/responses only. Defaults to anthropic.
 */
export declare function isAllowedLlmPath(method: string, path: string, upstream?: Upstream): boolean;

/** Headers to apply upstream for OpenAI: just Bearer SECRET (no anthropic-beta, no x-api-key). */
export declare function openaiAuthHeaders(secret: string): Record<string, string>;

/** Constant-time string compare (length-safe). */
export declare function constantTimeEqual(a: string, b: string): boolean;
