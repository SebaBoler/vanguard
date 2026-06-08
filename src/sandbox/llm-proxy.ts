import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';

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
 * Starts the trusted LLM reverse-proxy sidecar holding the real Anthropic credential. The sidecar
 * runs on the default bridge (has internet) and is also joined to the given internal enclave network
 * so the sandbox can reach it by name. The real secret reaches the sidecar ONLY via stdin into an
 * in-RAM tmpfs file (umask 077) — never via `-e` or argv, so `docker inspect` cannot reveal it. The
 * sandbox authenticates with the returned per-run nonce; the proxy swaps in the real auth upstream.
 */
export async function startLlmProxy(opts: {
  network: string;
  auth: { mode: 'subscription' | 'api'; secret: string };
  image?: string;
  docker?: DockerRunner;
}): Promise<LlmProxy> {
  const docker = opts.docker ?? defaultDocker;
  const image = opts.image ?? 'vanguard-sandbox:latest';
  const id = randomUUID().slice(0, 8);
  const name = `vg-llm-${id}`;
  const nonce = randomUUID().replace(/-/g, '');

  // The existing reapContainers (label vanguard.runId) already reaps this sidecar on gc — no gc change.
  const teardown = async (): Promise<void> => {
    await docker(['rm', '-f', name]);
  };

  try {
    // Sidecar on the default bridge (has internet), then also joined to the internal enclave network.
    await docker(['run', '-d', '--name', name, '--label', `vanguard.runId=${id}`, image, 'sleep', 'infinity']);
    await docker(['network', 'connect', opts.network, name]);
    await docker(['cp', PROXY_SCRIPT, `${name}:/tmp/llm-proxy.mjs`]);
    // The shared logic must sit next to the server so its relative import resolves.
    await docker(['cp', PROXY_LOGIC, `${name}:/tmp/llm-proxy-rewrite.mjs`]);
    // Write the secret file via stdin (umask 077) so the secret never appears in argv or docker inspect.
    const secretBody = `MODE=${opts.auth.mode}\nSECRET=${opts.auth.secret}\nNONCE=${nonce}\n`;
    const write = await docker(['exec', '-i', name, 'sh', '-c', `umask 077; cat > ${SECRET_FILE}`], { input: secretBody });
    if (write.exitCode !== 0) {
      throw new SandboxError(`Failed to write llm proxy secret: ${write.stderr}`);
    }
    await docker([
      'exec',
      '-d',
      '-e',
      `LLM_PROXY_SECRET_FILE=${SECRET_FILE}`,
      '-e',
      `PORT=${PROXY_PORT}`,
      name,
      'node',
      '/tmp/llm-proxy.mjs',
    ]);
    return { url: `http://${name}:${PROXY_PORT}`, nonce, host: name, destroy: teardown };
  } catch (cause) {
    await teardown();
    throw new SandboxError(`Failed to start llm proxy ${id}`, { cause });
  }
}
