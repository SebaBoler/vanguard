import { test, expect } from 'vitest';
import { startEgressEnclave } from './egress-network.js';
import type { DockerRunner } from './llm-proxy.js';

const ok = { exitCode: 0, stdout: '', stderr: '' };

function recordingDocker(failOn?: string): { calls: string[][]; docker: DockerRunner } {
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (failOn !== undefined && args[0] === failOn) return { exitCode: 1, stdout: '', stderr: 'boom' };
    return ok;
  };
  return { calls, docker };
}

test('the proxy runs as PID 1 under a restart policy — not an exec into a sleep container (dogfood #352)', async () => {
  const { calls, docker } = recordingDocker();
  const enclave = await startEgressEnclave({ allowlist: ['a.example'], docker });
  const create = calls.find((c) => c[0] === 'create');
  expect(create).toBeDefined();
  // Supervision: a proxy death must surface in docker logs and be revived, not leave a port-closed
  // "Up" container that bricks every remaining stage with ConnectionRefused.
  expect(create).toContain('--restart');
  expect(create![create!.indexOf('--restart') + 1]).toMatch(/^on-failure/);
  expect(create!.slice(-2)).toEqual(['node', '/tmp/egress-proxy.mjs']);
  expect(create!.join(' ')).not.toContain('sleep');
  // Env is baked at create time (exec -e no longer exists to carry it).
  expect(create!.join(' ')).toContain('ALLOW=a.example');
  expect(create!.join(' ')).toContain('PORT=8080');
  // The script is cp'd in BEFORE start — node is PID 1, so starting first would crash-loop on a
  // missing file.
  const order = calls.map((c) => c[0]);
  expect(order.indexOf('start')).toBeGreaterThan(order.lastIndexOf('cp'));
  expect(order).not.toContain('exec');
  expect(enclave.proxyUrl).toMatch(/^http:\/\/vg-proxy-[0-9a-f]{8}:8080$/);
  await enclave.destroy();
  expect(calls.filter((c) => c[0] === 'rm' || c[1] === 'rm').length).toBeGreaterThan(0);
});

test('a failed docker step tears the enclave down and throws SandboxError', async () => {
  const { calls, docker } = recordingDocker('cp');
  await expect(startEgressEnclave({ docker })).rejects.toThrow(/egress enclave/);
  // Teardown ran: the half-built container and network are removed.
  expect(calls.some((c) => c[0] === 'rm' && c[1] === '-f')).toBe(true);
  expect(calls.some((c) => c[0] === 'network' && c[1] === 'rm')).toBe(true);
});
