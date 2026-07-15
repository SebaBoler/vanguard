import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';
import { DEFAULT_EGRESS_ALLOWLIST } from './egress-proxy.js';
import { sidecarMemoryArgs } from './limits.js';
import type { DockerRunner } from './llm-proxy.js';

const PROXY_PORT = 8080;
// Resolves to dist/sandbox/egress-proxy-server.mjs (built) or src/... (tsx) — next to this module.
const PROXY_SCRIPT = fileURLToPath(new URL('./egress-proxy-server.mjs', import.meta.url));
// Shared allow logic the server imports via a relative `./egress-allow.mjs`; cp'd into the SAME
// /tmp dir so that relative import resolves inside the container.
const PROXY_LOGIC = fileURLToPath(new URL('./egress-allow.mjs', import.meta.url));

const defaultDocker: DockerRunner = async (args, opts) => {
  const result = await execa('docker', args, {
    reject: false,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
};

export interface EgressEnclave {
  /** Internal docker network the sandbox must join (no route to the internet, only to the proxy). */
  network: string;
  /** Proxy URL reachable from inside the internal network (by container name). */
  proxyUrl: string;
  destroy: () => Promise<void>;
}

/**
 * Hard egress enforcement: an `--internal` docker network (no internet) plus a proxy sidecar attached
 * to both that network and the default bridge. The sandbox joins only the internal network, so its
 * sole route out is the proxy — even a process that ignores HTTPS_PROXY has nowhere else to go. The
 * proxy only tunnels CONNECT to the allowlist. Caller joins the sandbox to `network` and points its
 * HTTPS_PROXY at `proxyUrl`, then calls destroy().
 *
 * The proxy node process is PID 1 with `--restart on-failure` — NOT a `sleep infinity` container
 * with an `exec -d`'d node (dogfood #352): there, a mid-run death of the exec'd process (OOM kill in
 * the 256 MB cgroup, a crash) left the container "Up" with the port closed, every later stage burned
 * minutes retrying into ConnectionRefused, and `docker logs` had nothing — exec'd stdout goes
 * nowhere. PID-1 + restart means docker both records the output and revives the proxy.
 */
export async function startEgressEnclave(
  opts: { allowlist?: readonly string[]; image?: string; docker?: DockerRunner } = {},
): Promise<EgressEnclave> {
  const docker = opts.docker ?? defaultDocker;
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const image = opts.image ?? 'vanguard-sandbox:latest';
  const id = randomUUID().slice(0, 8);
  const network = `vg-egr-${id}`;
  const proxy = `vg-proxy-${id}`;
  const teardown = async (): Promise<void> => {
    await docker(['rm', '-f', proxy]);
    await docker(['network', 'rm', network]);
  };
  const must = async (args: string[]): Promise<void> => {
    const result = await docker(args);
    if (result.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  };
  try {
    await must(['network', 'create', '--internal', network]);
    // Created (not started) on the default bridge so the script can be cp'd in first; joined to the
    // internal network before start.
    await must([
      'create',
      '--name',
      proxy,
      '--label',
      `vanguard.runId=${id}`,
      '--restart',
      'on-failure:10',
      ...sidecarMemoryArgs(),
      '-e',
      `ALLOW=${allowlist.join(',')}`,
      '-e',
      `PORT=${PROXY_PORT}`,
      image,
      'node',
      '/tmp/egress-proxy.mjs',
    ]);
    await must(['network', 'connect', network, proxy]);
    await must(['cp', PROXY_SCRIPT, `${proxy}:/tmp/egress-proxy.mjs`]);
    // The shared logic must sit next to the server so its relative import resolves.
    await must(['cp', PROXY_LOGIC, `${proxy}:/tmp/egress-allow.mjs`]);
    await must(['start', proxy]);
    return { network, proxyUrl: `http://${proxy}:${PROXY_PORT}`, destroy: teardown };
  } catch (cause) {
    await teardown();
    throw new SandboxError(`Failed to start egress enclave ${id}`, { cause });
  }
}
