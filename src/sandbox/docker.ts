import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { SandboxError } from '../core/errors.js';
import type { ExecOptions, ExecResult, ExecStream, IsolatedSandboxProvider, SandboxConfig } from './provider.js';

const DEFAULT_IMAGE = 'vanguard-sandbox:latest';
const DEFAULT_WORKDIR = '/workspace';
const SECRETS_DIR = '/run/vanguard';
const SECRETS_FILE = `${SECRETS_DIR}/secrets.env`;

type SecretsMode = 'tmpfs' | 'env-file';

/** Runs an isolated command environment as a detached Docker container. */
export class DockerSandboxProvider implements IsolatedSandboxProvider {
  readonly id: string;
  private readonly image: string;
  private readonly workdir: string;
  private readonly config: SandboxConfig;
  private readonly secretsMode: SecretsMode;
  private readonly secrets: Record<string, string>;
  private envDir: string | undefined;
  private started = false;

  constructor(config: SandboxConfig = {}) {
    this.config = config;
    this.id = randomUUID();
    this.image = config.image ?? DEFAULT_IMAGE;
    this.workdir = config.workdir ?? DEFAULT_WORKDIR;
    this.secretsMode = config.secretsMode ?? 'tmpfs';
    this.secrets = { ...config.secrets };
    for (const key of config.forwardEnv ?? []) {
      const value = process.env[key];
      if (value !== undefined) this.secrets[key] = value;
    }
    for (const [k, v] of Object.entries(this.secrets)) {
      if (/[\n\r]/.test(v)) throw new SandboxError(`Sekret ${k} zawiera znak nowej linii — niedozwolone`);
    }
  }

  private get name(): string {
    return `vg-${this.id}`;
  }

  private get hasSecrets(): boolean {
    return Object.keys(this.secrets).length > 0;
  }

  private secretsBody(): string {
    return Object.entries(this.secrets)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  }

  /** In tmpfs mode, source the in-RAM secrets file so values reach the command env without docker-inspect exposure. */
  private wrap(command: string): string {
    if (this.secretsMode !== 'tmpfs' || !this.hasSecrets) return command;
    return `set -a; [ -f ${SECRETS_FILE} ] && . ${SECRETS_FILE}; set +a; ${command}`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const args = ['run', '-d', '--name', this.name, '-w', this.workdir, '--label', `vanguard.runId=${this.id}`];
    if (this.config.memoryMb !== undefined) args.push('--memory', `${this.config.memoryMb}m`);
    if (this.config.cpus !== undefined) args.push('--cpus', String(this.config.cpus));
    if (this.config.pidsLimit !== undefined) args.push('--pids-limit', String(this.config.pidsLimit));

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // In-RAM tmpfs: secrets never land in the image, on disk, or in docker inspect Config.Env.
      args.push('--tmpfs', `${SECRETS_DIR}:rw,noexec,nosuid,mode=1777,size=1m`);
    }
    if (this.hasSecrets && this.secretsMode === 'env-file') {
      this.envDir = await mkdtemp(join(tmpdir(), 'vg-env-'));
      const file = join(this.envDir, 'env');
      await writeFile(file, this.secretsBody(), { mode: 0o600 });
      args.push('--env-file', file);
    }
    for (const [k, v] of Object.entries(this.config.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(this.image, 'sleep', 'infinity');

    try {
      await execa('docker', args);
      this.started = true;
    } catch (cause) {
      throw new SandboxError(`Nie udało się uruchomić kontenera ${this.name}`, { cause });
    }

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // Write the secrets file via stdin (umask 077) so the value never appears in argv.
      const write = await execa('docker', ['exec', '-i', this.name, 'sh', '-c', `umask 077; cat > ${SECRETS_FILE}`], {
        reject: false,
        input: this.secretsBody(),
      });
      if (write.exitCode !== 0) {
        await this.destroy();
        throw new SandboxError(`Nie udało się zapisać sekretów do tmpfs: ${write.stderr}`);
      }
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`);
    if (options.input !== undefined) args.push('-i');
    args.push(this.name, 'sh', '-lc', this.wrap(command));
    const result = await execa('docker', args, {
      reject: false,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  }

  execStream(command: string, options: ExecOptions = {}): ExecStream {
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(this.name, 'sh', '-lc', this.wrap(command));
    const child = execa('docker', args, {
      reject: false,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    });
    const stdout = (async function* (): AsyncIterable<string> {
      if (child.stdout === undefined || child.stdout === null) return;
      for await (const line of createInterface({ input: child.stdout })) yield line;
    })();
    const result: Promise<ExecResult> = child.then((r) => ({
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode ?? 1,
    }));
    return { stdout, result };
  }

  async copyIn(hostPath: string, sandboxPath: string): Promise<void> {
    try {
      const isDir = (await stat(hostPath)).isDirectory();
      await execa('docker', ['exec', this.name, 'mkdir', '-p', isDir ? sandboxPath : dirname(sandboxPath)]);
      const src = isDir ? `${hostPath}/.` : hostPath;
      await execa('docker', ['cp', src, `${this.name}:${sandboxPath}`]);
    } catch (cause) {
      throw new SandboxError(`copyIn nie powiódł się: ${hostPath} -> ${sandboxPath}`, { cause });
    }
  }

  async copyFileOut(sandboxPath: string, hostPath: string): Promise<void> {
    try {
      const isDir = (await execa('docker', ['exec', this.name, 'test', '-d', sandboxPath], { reject: false })).exitCode === 0;
      if (isDir) await mkdir(hostPath, { recursive: true });
      else await mkdir(dirname(hostPath), { recursive: true });
      const src = isDir ? `${this.name}:${sandboxPath}/.` : `${this.name}:${sandboxPath}`;
      await execa('docker', ['cp', src, hostPath]);
    } catch (cause) {
      throw new SandboxError(`copyFileOut nie powiódł się: ${sandboxPath} -> ${hostPath}`, { cause });
    }
  }

  async exists(sandboxPath: string): Promise<boolean> {
    const result = await execa('docker', ['exec', this.name, 'test', '-e', sandboxPath], { reject: false });
    return result.exitCode === 0;
  }

  async destroy(): Promise<void> {
    await execa('docker', ['rm', '-f', this.name], { reject: false });
    this.started = false;
    if (this.envDir !== undefined) {
      await rm(this.envDir, { recursive: true, force: true });
      this.envDir = undefined;
    }
  }
}
