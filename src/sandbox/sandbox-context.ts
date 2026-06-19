import { startEgressEnclave } from './egress-network.js';
import { startLlmProxy } from './llm-proxy.js';
import { llmProxyEgressAllowlist } from './egress-proxy.js';
import { llmProxyAuth } from '../agents/auth.js';
import type { LlmProxyDep } from './llm-proxy.js';
import type { Upstream } from './llm-proxy-rewrite.mjs';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderName } from '../agents/registry.js';

/**
 * The sandbox-side wiring shared by `vanguard run` and `vanguard watch`: the egress enclave's proxy
 * URL + network, and (when `--llm-proxy` is active) the trusted LLM-proxy sidecar's url/nonce/host.
 * `destroy()` tears the whole thing down in the right order.
 */
export interface SandboxContext {
  /** Egress proxy URL the sandbox routes through (absent when no enclave was created). */
  proxyUrl?: string;
  /** Internal docker network the sandbox joins (absent when no enclave was created). */
  network?: string;
  /** LLM-proxy sidecar wiring (absent unless `--llm-proxy`). */
  llmProxy?: LlmProxyDep;
  destroy: () => Promise<void>;
}

/** Options for {@link startSandboxContext}. */
export interface SandboxContextOptions {
  egress: boolean;
  llmProxy: boolean;
  /**
   * The primary sidecar's credential. For Anthropic (default) this is the Claude subscription/API auth;
   * for Zai it is the z.ai key carried as an api-mode auth (`agentAuthFromEnv('zai')` reads ZAI_API_KEY).
   */
  auth: AgentAuth;
  /** Provider whose primary LLM sidecar to start under --llm-proxy (default 'claude' → Anthropic). */
  provider?: ProviderName;
  /** Injectable env (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the primary LLM-proxy sidecar's upstream + secret for the chosen provider. Claude/Codex/Cursor
 * use the Anthropic upstream; Zai uses the z.ai upstream (zai reuses the Claude Code CLI against z.ai's
 * Anthropic-compatible endpoint, so its sidecar forwards to api.z.ai with a bearer key). The credential
 * is taken uniformly from `auth` — for Zai that carries the z.ai key as an api-mode secret.
 */
function resolvePrimaryProxy(
  opts: SandboxContextOptions,
  _env: NodeJS.ProcessEnv,
): { upstream: Upstream; auth: { mode: 'subscription' | 'api'; secret: string } } {
  if (opts.provider === 'zai') {
    return { upstream: 'zai', auth: llmProxyAuth(opts.auth) };
  }
  return { upstream: 'anthropic', auth: llmProxyAuth(opts.auth) };
}

/**
 * Provision the sandbox context once for a command. Builds the egress enclave when `egress` or
 * `llmProxy` is set (dropping the sidecar-owned upstream hosts — Anthropic, OpenAI, and z.ai — from the
 * allowlist in llm-proxy mode, so the sandbox has no direct route to those providers), and starts the
 * LLM-proxy sidecar on that enclave's network when requested — holding the real provider credential
 * outside the sandbox. The primary sidecar's upstream follows the provider: Anthropic by default, z.ai
 * for `--provider zai`. With neither flag, no enclave or env is created and `destroy()` is a no-op.
 */
export async function startSandboxContext(opts: SandboxContextOptions): Promise<SandboxContext> {
  // --llm-proxy implies the egress enclave; in that mode the sandbox loses its direct route to the
  // sidecar-owned upstream providers (Anthropic, OpenAI, z.ai).
  if (!opts.egress && !opts.llmProxy) {
    return { destroy: async (): Promise<void> => {} };
  }

  const enclave = await startEgressEnclave(
    opts.llmProxy ? { allowlist: llmProxyEgressAllowlist() } : {},
  );
  console.log('egress: sandbox confined to an internal network; only the allowlist proxy can reach out.');

  if (!opts.llmProxy) {
    return { proxyUrl: enclave.proxyUrl, network: enclave.network, destroy: enclave.destroy };
  }

  const { upstream, auth } = resolvePrimaryProxy(opts, opts.env ?? process.env);
  const llmProxy = await startLlmProxy({ network: enclave.network, auth, ...(upstream === 'anthropic' ? {} : { upstream }) });
  console.log(
    upstream === 'zai'
      ? 'llm-proxy: z.ai credential held in a trusted sidecar; the sandbox sees only a per-run nonce.'
      : 'llm-proxy: Claude credential held in a trusted sidecar; the sandbox sees only a per-run nonce.',
  );

  return {
    proxyUrl: enclave.proxyUrl,
    network: enclave.network,
    llmProxy: { url: llmProxy.url, nonce: llmProxy.nonce, host: llmProxy.host },
    // Destroy the llm-proxy before the enclave (it lives on the enclave's network).
    destroy: async (): Promise<void> => {
      await llmProxy.destroy();
      await enclave.destroy();
    },
  };
}
