import { startEgressEnclave } from './egress-network.js';
import { startLlmProxy } from './llm-proxy.js';
import { llmProxyEgressAllowlist } from './egress-proxy.js';
import { llmProxyAuth } from '../agents/auth.js';
import type { LlmProxyDep } from './llm-proxy.js';
import type { AgentAuth } from '../agents/auth.js';

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

/**
 * Provision the sandbox context once for a command. Builds the egress enclave when `egress` or
 * `llmProxy` is set (dropping the sidecar-owned upstream hosts — Anthropic and OpenAI — from the
 * allowlist in llm-proxy mode, so the sandbox has no direct route to those providers), and starts the
 * LLM-proxy sidecar on that enclave's network when
 * requested — holding the real Claude credential outside the sandbox. With neither flag, no enclave or
 * env is created and `destroy()` is a no-op.
 */
export async function startSandboxContext(opts: {
  egress: boolean;
  llmProxy: boolean;
  auth: AgentAuth;
}): Promise<SandboxContext> {
  // --llm-proxy implies the egress enclave; in that mode the sandbox loses its direct route to the
  // sidecar-owned upstream providers (Anthropic and OpenAI).
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

  const llmProxy = await startLlmProxy({ network: enclave.network, auth: llmProxyAuth(opts.auth) });
  console.log('llm-proxy: Claude credential held in a trusted sidecar; the sandbox sees only a per-run nonce.');

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
