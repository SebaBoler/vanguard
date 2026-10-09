import { describe, it, expect } from 'vitest';
import { startSidecar } from './sidecar.js';

type Call = { args: string[]; input?: string };
/** Docker stub: every call succeeds unless `fail` matches its first two words; records calls. */
function stubDocker(calls: Call[], fail?: string) {
  return async (args: string[], opts?: { input?: string }) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    if (fail !== undefined && args.slice(0, 2).join(' ') === fail) return { exitCode: 1, stdout: '', stderr: `${fail} broke` };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}
const base = { name: 'vg-x-1', runId: '1', image: 'img', files: [{ src: '/h/a.mjs', dest: '/tmp/a.mjs' }], cmd: ['node', '/tmp/a.mjs'] as const };

describe('startSidecar', () => {
  it('PID-1 mode: create → connect → cp → start, labels and env on the create', async () => {
    const calls: Call[] = [];
    const s = await startSidecar({ ...base, docker: stubDocker(calls), network: 'net', env: { PORT: '1' }, createArgs: ['--restart', 'on-failure:10'] });
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['create --name', 'network connect', 'cp /h/a.mjs', 'start vg-x-1']);
    const create = calls[0]!.args;
    expect(create).toEqual(expect.arrayContaining(['--label', 'vanguard.runId=1', '--restart', 'on-failure:10', '-e', 'PORT=1', 'img', 'node', '/tmp/a.mjs']));
    expect(calls[2]!.args).toEqual(['cp', '/h/a.mjs', 'vg-x-1:/tmp/a.mjs']);
    await s.destroy();
    expect(calls.at(-1)!.args).toEqual(['rm', '-f', 'vg-x-1']);
  });

  it('secret mode: idle run → connect → cp → secret over stdin (umask 077) → exec -d with env; the secret never reaches argv', async () => {
    const calls: Call[] = [];
    await startSidecar({ ...base, docker: stubDocker(calls), network: 'net', env: { PORT: '2' }, secret: { path: '/tmp/s', body: 'SECRET=hunter2\n' } });
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['run -d', 'network connect', 'cp /h/a.mjs', 'exec -i', 'exec -d']);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['sleep', 'infinity']));
    expect(calls[3]!.input).toBe('SECRET=hunter2\n');
    expect(calls[3]!.args.join(' ')).toContain('umask 077; cat > /tmp/s');
    expect(calls[4]!.args).toEqual(['exec', '-d', '-e', 'PORT=2', 'vg-x-1', 'node', '/tmp/a.mjs']);
    expect(calls.flatMap((c) => c.args).join(' ')).not.toContain('hunter2');
  });

  for (const step of ['create --name', 'network connect', 'cp /h/a.mjs', 'start vg-x-1']) {
    it(`fails closed when \`docker ${step}\` exits non-zero: tears down and throws`, async () => {
      const calls: Call[] = [];
      await expect(startSidecar({ ...base, docker: stubDocker(calls, step), network: 'net' })).rejects.toThrow(/Failed to start sidecar vg-x-1/);
      expect(calls.at(-1)!.args).toEqual(['rm', '-f', 'vg-x-1']);
      expect(calls.some((c) => c.args[0] === 'start' && c.args[1] === 'vg-x-1' && step !== 'start vg-x-1')).toBe(false);
    });
  }

  it('secret mode fails closed on a non-zero exec -d (the process never started)', async () => {
    const calls: Call[] = [];
    await expect(startSidecar({ ...base, docker: stubDocker(calls, 'exec -d'), secret: { path: '/tmp/s', body: 'x' } })).rejects.toThrow(/Failed to start sidecar/);
    expect(calls.at(-1)!.args).toEqual(['rm', '-f', 'vg-x-1']);
  });

  it('runs alsoDestroy after removing the container', async () => {
    const calls: Call[] = [];
    const order: string[] = [];
    const docker = async (args: string[]) => { calls.push({ args }); if (args[0] === 'rm') order.push('rm'); return { exitCode: 0, stdout: '', stderr: '' }; };
    const s = await startSidecar({ ...base, docker, alsoDestroy: async () => { order.push('also'); } });
    await s.destroy();
    expect(order).toEqual(['rm', 'also']);
  });
});
