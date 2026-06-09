import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';
import { DEFAULT_EGRESS_ALLOWLIST } from './egress-proxy.js';
import { sidecarMemoryArgs } from './limits.js';

const PROXY_PORT = 8080;
// Resolves to dist/sandbox/egress-proxy-server.mjs (built) or src/... (tsx) — next to this module.
const PROXY_SCRIPT = fileURLToPath(new URL('./egress-proxy-server.mjs', import.meta.url));
// Shared allow logic the server imports via a relative `./egress-allow.mjs`; cp'd into the SAME
// /tmp dir so that relative import resolves inside the container.
const PROXY_LOGIC = fileURLToPath(new URL('./egress-allow.mjs', import.meta.url));

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
 */
export async function startEgressEnclave(opts: { allowlist?: readonly string[]; image?: string } = {}): Promise<EgressEnclave> {
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const image = opts.image ?? 'vanguard-sandbox:latest';
  const id = randomUUID().slice(0, 8);
  const network = `vg-egr-${id}`;
  const proxy = `vg-proxy-${id}`;
  const teardown = async (): Promise<void> => {
    await execa('docker', ['rm', '-f', proxy], { reject: false });
    await execa('docker', ['network', 'rm', network], { reject: false });
  };
  try {
    await execa('docker', ['network', 'create', '--internal', network]);
    // Proxy on the default bridge (has internet), then also joined to the internal network.
    await execa('docker', ['run', '-d', '--name', proxy, '--label', `vanguard.runId=${id}`, ...sidecarMemoryArgs(), image, 'sleep', 'infinity']);
    await execa('docker', ['network', 'connect', network, proxy]);
    await execa('docker', ['cp', PROXY_SCRIPT, `${proxy}:/tmp/egress-proxy.mjs`]);
    // The shared logic must sit next to the server so its relative import resolves.
    await execa('docker', ['cp', PROXY_LOGIC, `${proxy}:/tmp/egress-allow.mjs`]);
    await execa('docker', [
      'exec',
      '-d',
      '-e',
      `ALLOW=${allowlist.join(',')}`,
      '-e',
      `PORT=${PROXY_PORT}`,
      proxy,
      'node',
      '/tmp/egress-proxy.mjs',
    ]);
    return { network, proxyUrl: `http://${proxy}:${PROXY_PORT}`, destroy: teardown };
  } catch (cause) {
    await teardown();
    throw new SandboxError(`Failed to start egress enclave ${id}`, { cause });
  }
}
