import { describe, it, expect, afterAll } from 'vitest';
import { execa, execaSync } from 'execa';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandboxProvider } from './docker.js';

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
