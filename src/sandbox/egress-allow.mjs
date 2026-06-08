// Pure allow-check semantics for the egress CONNECT proxy.
// Authored as plain ESM `.mjs` so BOTH the strict-TS host (`egress-proxy.ts`) and the zero-dep
// sidecar (`egress-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `egress-allow.d.mts`. The sidecar gets this file `docker cp`'d next to
// it so the relative `import './egress-allow.mjs'` resolves.

/** Domains the sandbox legitimately needs: the agent, task sources, and package registries. */
export const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com',
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
