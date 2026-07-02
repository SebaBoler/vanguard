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
/** Display name for each llm-proxy upstream, used in the sidecar-credential log line. */
const UPSTREAM_LABEL: Record<Upstream, string> = { anthropic: 'Claude', openai: 'OpenAI', zai: 'z.ai', openrouter: 'OpenRouter' };

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
   * for Zai/OpenRouter it is the provider key carried as an api-mode auth. Absent when no
   * Anthropic-family credential is needed and --llm-proxy is not active (proxy mode always needs a
   * primary-sidecar credential).
   */
  auth?: AgentAuth;
  /** Provider whose primary LLM sidecar to start under --llm-proxy (default 'claude' → Anthropic). */
  provider?: ProviderName;
}

/**
 * Provision the sandbox context once for a command. Builds the egress enclave when `egress` or
 * `llmProxy` is set (dropping the sidecar-owned upstream hosts from the allowlist in llm-proxy mode,
 * so the sandbox has no direct route to those providers), and starts the LLM-proxy sidecar on that
 * enclave's network when requested — holding the real provider credential outside the sandbox. The
 * primary sidecar's upstream follows the provider: Anthropic by default, z.ai for `--provider zai`,
 * OpenRouter for `--provider openrouter`. With neither flag, no enclave or env is created and
 * `destroy()` is a no-op.
 */
export async function startSandboxContext(opts: SandboxContextOptions): Promise<SandboxContext> {
  // --llm-proxy implies the egress enclave; in that mode the sandbox loses its direct route to the
  // sidecar-owned upstream providers.
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

  // The primary sidecar's upstream follows the provider; the credential comes uniformly from `auth`.
  if (opts.auth === undefined) {
    throw new Error(
      'llm-proxy needs a primary-sidecar credential (set CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY, ZAI_API_KEY, or OPENROUTER_API_KEY).',
    );
  }
  const upstream: Upstream = opts.provider === 'zai' || opts.provider === 'openrouter' ? opts.provider : 'anthropic';
  const auth = llmProxyAuth(opts.auth);
  const llmProxy = await startLlmProxy({ network: enclave.network, auth, ...(upstream === 'anthropic' ? {} : { upstream }) });
  console.log(`llm-proxy: ${UPSTREAM_LABEL[upstream]} credential held in a trusted sidecar; the sandbox sees only a per-run nonce.`);

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
