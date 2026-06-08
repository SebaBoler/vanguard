// Type declarations for the plain-ESM `llm-proxy-rewrite.mjs` so the strict-TS app keeps types.
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

/** Only POST to the two Claude Code messages endpoints (query string ignored). */
export declare function isAllowedLlmPath(method: string, path: string): boolean;

/** Constant-time string compare (length-safe). */
export declare function constantTimeEqual(a: string, b: string): boolean;
