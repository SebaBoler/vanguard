import { describe, it, expect, afterAll } from 'vitest';
import { execa, execaSync } from 'execa';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandboxProvider } from './docker.js';
import { sandboxSecurityOpts } from './limits.js';

const hasDocker = ((): boolean => {
  try {
    execaSync('docker', ['version']);
    return true;
  } catch {
    return false;
  }
})();

const suite = hasDocker ? describe : describe.skip;

suite('DockerSandboxProvider', () => {
  const sb = new DockerSandboxProvider({ image: 'alpine:3.20', workdir: '/workspace' });

  afterAll(async () => {
    await sb.destroy();
  }, 60_000);

  it('starts and runs a command', async () => {
    await sb.start();
    const r = await sb.exec('echo hi');
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('returns a non-zero exit code without throwing', async () => {
    const r = await sb.exec('exit 3');
    expect(r.exitCode).toBe(3);
  }, 30_000);

  it('round-trips a directory of files (contents, not nested)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-cp-'));
    await writeFile(join(host, 'a.txt'), 'alpha');
    await sb.copyIn(host, '/workspace/in');
    expect(await sb.exists('/workspace/in/a.txt')).toBe(true);
    const out = await mkdtemp(join(tmpdir(), 'vg-out-'));
    await sb.copyFileOut('/workspace/in', out);
    expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('alpha');
    await rm(host, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }, 60_000);

  it('makes copied-in files editable by the sandbox user (chown)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-edit-'));
    await writeFile(join(host, 'f.txt'), 'one');
    await sb.copyIn(host, '/workspace/edit');
    const r = await sb.exec('echo two >> /workspace/edit/f.txt && cat /workspace/edit/f.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('two');
    await rm(host, { recursive: true, force: true });
  }, 60_000);

  it('exposes secrets to commands but keeps them out of docker inspect (tmpfs default)', async () => {
    const sec = new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { VG_SECRET: 'topsecret' } });
    try {
      await sec.start();
      const r = await sec.exec('echo $VG_SECRET');
      expect(r.stdout.trim()).toBe('topsecret');
      const inspect = await execa('docker', ['inspect', `vg-${sec.id}`, '--format', '{{json .Config.Env}}'], {
        reject: false,
      });
      expect(inspect.stdout).not.toContain('topsecret');
    } finally {
      await sec.destroy();
    }
  }, 120_000);

  it('keeps shell metacharacters in secret values literal (no injection)', async () => {
    const tricky = "a'b$(echo pwned);c`d`";
    const sec = new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { VG_TRICKY: tricky } });
    try {
      await sec.start();
      const r = await sec.exec('printf %s "$VG_TRICKY"');
      expect(r.stdout).toBe(tricky);
    } finally {
      await sec.destroy();
    }
  }, 120_000);
});

// Runs without Docker: exercises the pure argv builder directly.
describe('DockerSandboxProvider buildRunArgs (hardening flags)', () => {
  it('drops all capabilities and blocks privilege escalation by default', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--security-opt');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('adds back the chown trio needed by copyIn, after the drop', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    const dropIdx = args.indexOf('--cap-drop');
    for (const cap of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']) {
      const capIdx = args.indexOf(cap);
      expect(capIdx).toBeGreaterThan(-1);
      expect(args[capIdx - 1]).toBe('--cap-add');
      expect(capIdx).toBeGreaterThan(dropIdx);
    }
  });

  it('coexists with resource limits, network, secrets tmpfs, and the terminal image/command', () => {
    const sb = new DockerSandboxProvider({
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 128,
      network: 'vg-net',
      secrets: { FOO: 'bar' },
      security: sandboxSecurityOpts({}),
    });
    const args = sb.buildRunArgs();
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--network');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('--security-opt');
    expect(args.filter((a) => a === '--tmpfs').length).toBeGreaterThanOrEqual(1);
    expect(args.slice(-3)).toEqual(['vanguard-sandbox:latest', 'sleep', 'infinity']);
  });

  it('config.security override disables hardening', () => {
    const sb = new DockerSandboxProvider({
      security: { capDrop: [], capAdd: [], noNewPrivileges: false, readOnlyRootfs: false },
    });
    const args = sb.buildRunArgs();
    expect(args).not.toContain('--cap-drop');
    expect(args).not.toContain('--cap-add');
    expect(args).not.toContain('--security-opt');
    expect(args).not.toContain('--read-only');
  });

  it('config.security override can customize the added-back caps', () => {
    const sb = new DockerSandboxProvider({ security: { capAdd: ['NET_BIND_SERVICE'] } });
    const args = sb.buildRunArgs();
    expect(args).toContain('NET_BIND_SERVICE');
    expect(args).not.toContain('CHOWN');
  });

  it('stretch: readOnlyRootfs adds --read-only and writable tmpfs for workspace/$HOME/tmp', () => {
    const sb = new DockerSandboxProvider({ security: { ...sandboxSecurityOpts({}), readOnlyRootfs: true } });
    const args = sb.buildRunArgs();
    expect(args).toContain('--read-only');
    const tmpfsArgs = args.filter((_, i) => args[i - 1] === '--tmpfs');
    expect(tmpfsArgs.some((a) => a.startsWith('/workspace:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/home/agent:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/tmp:'))).toBe(true);
  });

  it('stretch: readOnlyRootfs is off by default', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    expect(args).not.toContain('--read-only');
  });
});

// Runs without Docker: the validation throws in the constructor, before any docker invocation.
describe('DockerSandboxProvider secret validation', () => {
  it('rejects a secret value containing a newline', () => {
    expect(() => new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { BAD: 'a\nb' } })).toThrow(/newline/);
  });

  it('rejects an invalid secret name', () => {
    expect(() => new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { 'bad name': 'x' } })).toThrow(
      /Invalid secret name/,
    );
  });

  it('builds an interactive shell command', () => {
    const sb = new DockerSandboxProvider({ image: 'alpine:3.20' });
    expect(sb.shellCommand()).toMatch(/^docker exec -it vg-.* bash$/);
  });
});
