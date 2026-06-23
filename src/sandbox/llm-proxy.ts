import { execa } from 'execa';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';
import { sidecarMemoryArgs } from './limits.js';
import type { ProviderProxySecrets } from '../agents/registry.js';
import type { Upstream } from './llm-proxy-rewrite.mjs';

const PROXY_PORT = 8088;
const SECRET_FILE = '/tmp/llm-proxy-secret';
// Resolves to dist/sandbox/llm-proxy-server.mjs (built) or src/... (tsx) — next to this module.
const PROXY_SCRIPT = fileURLToPath(new URL('./llm-proxy-server.mjs', import.meta.url));
// Shared pure logic the server imports via a relative `./llm-proxy-rewrite.mjs`; cp'd into the SAME
// /tmp dir so that relative import resolves inside the container.
const PROXY_LOGIC = fileURLToPath(new URL('./llm-proxy-rewrite.mjs', import.meta.url));

/** Injectable docker runner so the host orchestration is testable without touching real docker. */
export type DockerRunner = (
  args: string[],
  opts?: { input?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Default runner: execa-based docker invocation (reject:false so the caller inspects exitCode). */
const defaultDocker: DockerRunner = async (args, opts) => {
  const result = await execa('docker', args, {
    reject: false,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
};

export interface LlmProxy {
  /** Proxy URL reachable from inside the internal network (by container name). */
  url: string;
  /** Per-run nonce the sandbox presents as ANTHROPIC_AUTH_TOKEN; the proxy validates it. */
  nonce: string;
  /** Sidecar container name (the `vg-llm-<id>` host inside the url) — also the NO_PROXY entry. */
  host: string;
  destroy: () => Promise<void>;
}

/** The per-source LLM-proxy wiring threaded into a runner when `--llm-proxy` is active. */
export interface LlmProxyDep {
  /** Proxy URL the sandbox uses as ANTHROPIC_BASE_URL. */
  url: string;
  /** Per-run nonce the sandbox presents as ANTHROPIC_AUTH_TOKEN. */
  nonce: string;
  /** Sidecar container name (added to NO_PROXY so the sandbox reaches it directly). */
  host: string;
}

/**
 * Starts the trusted LLM reverse-proxy sidecar holding the real provider credential. Serves either
 * the Anthropic or OpenAI upstream depending on `opts.upstream` (default `'anthropic'`); for OpenAI
 * the real OpenAI key is the `auth.secret`. The sidecar runs on the default bridge (has internet) and
 * is also joined to the given internal enclave network so the sandbox can reach it by name. The real
 * secret reaches the sidecar ONLY via stdin into an in-RAM tmpfs file (umask 077) — never via `-e` or
 * argv, so `docker inspect` cannot reveal it. The sandbox authenticates with the returned per-run
 * nonce; the proxy swaps in the real auth upstream.
 */
// Container-side path for the host cacheDir bind-mount (used for quota snapshots).
const CONTAINER_QUOTA_DIR = '/tmp/vg-quota';
// Bucket name for the Anthropic/Claude header-fed quota snapshot (matches bucketPath convention).
const CLAUDE_BUCKET = 'claude';

export async function startLlmProxy(opts: {
  network: string;
  auth: { mode: 'subscription' | 'api'; secret: string };
  upstream?: Upstream;
  image?: string;
  docker?: DockerRunner;
  /**
   * Host-side directory where quota snapshots are stored (the cacheDir from quotaRoutedAgent).
   * When set and upstream is 'anthropic', the sidecar writes harvested rate-limit data to
   * `<cacheDir>/claude.json` via a bind-mount, making it readable by pctBucketCheck on the host.
   */
  cacheDir?: string;
}): Promise<LlmProxy> {
  const docker = opts.docker ?? defaultDocker;
  const image = opts.image ?? 'vanguard-sandbox:latest';
  const upstream: Upstream = opts.upstream ?? 'anthropic';
  const id = randomUUID().slice(0, 8);
  const name = `vg-llm-${id}`;
  const nonce = randomUUID().replace(/-/g, '');
  const quotaMount = opts.cacheDir !== undefined && upstream === 'anthropic' ? opts.cacheDir : undefined;

  // The existing reapContainers (label vanguard.runId) already reaps this sidecar on gc — no gc change.
  const teardown = async (): Promise<void> => {
    await docker(['rm', '-f', name]);
  };

  try {
    if (quotaMount !== undefined) mkdirSync(quotaMount, { recursive: true });
    // Sidecar on the default bridge (has internet), then also joined to the internal enclave network.
    const runArgs = ['run', '-d', '--name', name, '--label', `vanguard.runId=${id}`, ...sidecarMemoryArgs()];
    if (quotaMount !== undefined) runArgs.push('-v', `${quotaMount}:${CONTAINER_QUOTA_DIR}:rw`);
    runArgs.push(image, 'sleep', 'infinity');
    await docker(runArgs);
    await docker(['network', 'connect', opts.network, name]);
    await docker(['cp', PROXY_SCRIPT, `${name}:/tmp/llm-proxy.mjs`]);
    // The shared logic must sit next to the server so its relative import resolves.
    await docker(['cp', PROXY_LOGIC, `${name}:/tmp/llm-proxy-rewrite.mjs`]);
    // Write the secret file via stdin (umask 077) so the secret never appears in argv or docker inspect.
    const secretBody = `MODE=${opts.auth.mode}\nSECRET=${opts.auth.secret}\nNONCE=${nonce}\nUPSTREAM=${upstream}\n`;
    const write = await docker(['exec', '-i', name, 'sh', '-c', `umask 077; cat > ${SECRET_FILE}`], { input: secretBody });
    if (write.exitCode !== 0) {
      throw new SandboxError(`Failed to write llm proxy secret: ${write.stderr}`);
    }
    const execArgs = ['exec', '-d', '-e', `LLM_PROXY_SECRET_FILE=${SECRET_FILE}`, '-e', `PORT=${PROXY_PORT}`];
    if (quotaMount !== undefined) execArgs.push('-e', `LLM_PROXY_QUOTA_FILE=${CONTAINER_QUOTA_DIR}/${CLAUDE_BUCKET}.json`);
    execArgs.push(name, 'node', '/tmp/llm-proxy.mjs');
    await docker(execArgs);
    return { url: `http://${name}:${PROXY_PORT}`, nonce, host: name, destroy: teardown };
  } catch (cause) {
    await teardown();
    throw new SandboxError(`Failed to start llm proxy ${id}`, { cause });
  }
}

/** The per-run provider-sidecar handles plus a single teardown for whatever was started. */
export interface ProviderProxies {
  /** OpenAI/Codex sidecar dep, present only when a Codex key was proxied. */
  openai?: LlmProxyDep;
  /** Tear down every sidecar started here. Safe to call when none were started. */
  destroy: () => Promise<void>;
}

/**
 * Start the per-run provider proxy sidecars implied by `proxySecrets` (from SelectedAgents). Currently:
 * an OpenAI upstream sidecar when a Codex key was proxied (Codex in --llm-proxy mode). This is the one
 * place that maps a proxied provider key to its sidecar, so adding a future proxyable provider is local
 * to here. The real key reaches the sidecar only via startLlmProxy's stdin tmpfs delivery — never the
 * sandbox. Requires the enclave `network`; throws a clear SandboxError if a key is given without one.
 */
export async function startProviderProxies(opts: {
  /** Proxied provider keys held by sidecars (from SelectedAgents.proxySecrets). */
  proxySecrets: ProviderProxySecrets;
  network?: string;
  image?: string;
  docker?: DockerRunner;
}): Promise<ProviderProxies> {
  const openaiKey = opts.proxySecrets.codex;
  if (openaiKey === undefined) {
    return { destroy: async (): Promise<void> => {} };
  }
  if (opts.network === undefined) {
    throw new SandboxError('OpenAI provider proxy needs the egress enclave network');
  }
  const proxy = await startLlmProxy({
    network: opts.network,
    auth: { mode: 'api', secret: openaiKey },
    upstream: 'openai',
    ...(opts.image !== undefined ? { image: opts.image } : {}),
    ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
  });
  return {
    openai: { url: proxy.url, nonce: proxy.nonce, host: proxy.host },
    destroy: (): Promise<void> => proxy.destroy(),
  };
}
