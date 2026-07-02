// Pure allow-check semantics for the egress CONNECT proxy.
// Authored as plain ESM `.mjs` so BOTH the strict-TS host (`egress-proxy.ts`) and the zero-dep
// sidecar (`egress-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `egress-allow.d.mts`. The sidecar gets this file `docker cp`'d next to
// it so the relative `import './egress-allow.mjs'` resolves.

/** Domains the sandbox legitimately needs: the agent, task sources, and package registries. */
export const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com',
  // Codex/OpenAI direct mode (--egress without --llm-proxy): the sandbox reaches OpenAI directly via
  // this entry. Under --llm-proxy this host is dropped from the sandbox allowlist (see llmProxyEgressAllowlist).
  'api.openai.com',
  // z.ai (GLM Coding Plan, --provider zai) direct mode: the Claude Code CLI talks to z.ai's
  // Anthropic-compatible coding endpoint. Dropped under --llm-proxy (the sidecar owns it).
  'api.z.ai',
  // OpenRouter direct mode (--provider openrouter --egress). Dropped under --llm-proxy.
  'openrouter.ai',
  'api.linear.app',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
];

/** True if host equals an allowlist entry or is a subdomain of one (so `github.com.evil.com` is denied). */
export function isAllowed(host, allowlist) {
  const h = host.toLowerCase();
  return allowlist.some((domain) => h === domain || h.endsWith(`.${domain}`));
}
