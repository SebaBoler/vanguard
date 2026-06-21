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
// One path per container; stages run sequentially per sandbox (fan-out uses separate sandboxes).
const STAGE_SECRETS_FILE = `${SECRETS_DIR}/stage.env`;

type SecretsMode = 'tmpfs' | 'env-file';

/** POSIX single-quote a value, safe to `source`/`export` in a shell (no expansion or injection). */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** POSIX single-quoted KEY='value' lines, safe to `source` in a shell. */
function shellBody(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${sq(value)}`)
    .join('\n');
}

/** Validate secret names and values; throw SandboxError on bad name or newline value. */
function validateSecrets(record: Record<string, string>): void {
  for (const [key, value] of Object.entries(record)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SandboxError(`Invalid secret name: ${key}`);
    }
    if (/[\n\r]/.test(value)) {
      throw new SandboxError(`Secret ${key} contains a newline, which is not allowed`);
    }
  }
}

/** Runs an isolated command environment as a detached Docker container. */
export class DockerSandboxProvider implements IsolatedSandboxProvider {
  readonly id: string;
  private readonly image: string;
  private readonly workdir: string;
  private readonly config: SandboxConfig;
  private readonly secretsMode: SecretsMode;
  private readonly secrets: Record<string, string>;
  private envDir: string | undefined;
  private owner: string | undefined;
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
    validateSecrets(this.secrets);
  }

  private get name(): string {
    return `vg-${this.id}`;
  }

  private get hasSecrets(): boolean {
    return Object.keys(this.secrets).length > 0;
  }

  /** Raw KEY=value lines for docker --env-file (parsed literally by docker, never by a shell). */
  private secretsBody(): string {
    return Object.entries(this.secrets)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  /** In tmpfs mode, source the in-RAM secrets file(s) so values reach the command env without docker-inspect exposure. */
  private wrap(command: string, sourceStage = false, envExports = ''): string {
    if (this.secretsMode !== 'tmpfs') return command;
    const sources = [
      this.hasSecrets ? `[ -f ${SECRETS_FILE} ] && . ${SECRETS_FILE}` : '',
      sourceStage ? `[ -f ${STAGE_SECRETS_FILE} ] && . ${STAGE_SECRETS_FILE}` : '',
    ].filter(Boolean).join('; ');
    if (sources === '') return command;
    // per-exec env is exported AFTER the source block so it overrides run-level/stage secrets on key collision.
    return `set -a; ${sources}; set +a; ${envExports}${command}`;
  }

  /**
   * Resolve per-exec env into docker `-e` args OR post-source `export` statements, then wrap the command.
   * When secrets are sourced (tmpfs), `set -a; . secrets.env` would overwrite any colliding `-e` var, so
   * per-exec env must be applied AFTER sourcing to win ("most-specific wins"). Env values are non-secret
   * transport vars (already argv-visible via `-e`), so emitting them in the `sh -lc` string is the same
   * visibility class — real credentials never travel this channel (they go through `secrets`/tmpfs).
   */
  private envAndWrap(command: string, options: ExecOptions, hasStageSecrets: boolean): { envArgs: string[]; wrapped: string } {
    const entries = Object.entries(options.env ?? {});
    const sourced = this.secretsMode === 'tmpfs' && (this.hasSecrets || hasStageSecrets);
    if (sourced && entries.length > 0) {
      validateSecrets(options.env as Record<string, string>);
      const envExports = entries.map(([k, v]) => `export ${k}=${sq(v)}; `).join('');
      return { envArgs: [], wrapped: this.wrap(command, hasStageSecrets, envExports) };
    }
    const envArgs: string[] = [];
    for (const [k, v] of entries) envArgs.push('-e', `${k}=${v}`);
    return { envArgs, wrapped: this.wrap(command, hasStageSecrets) };
  }

  async start(): Promise<void> {
    if (this.started) return;
    const args = ['run', '-d', '--name', this.name, '-w', this.workdir, '--label', `vanguard.runId=${this.id}`];
    // Make the host reachable as host.docker.internal (so HTTPS_PROXY can point at a host egress
    // proxy). Default on Docker Desktop; required on Linux. host-gateway needs Docker >= 20.10.
    args.push('--add-host', 'host.docker.internal:host-gateway');
    if (this.config.network !== undefined) args.push('--network', this.config.network);
    if (this.config.memoryMb !== undefined) args.push('--memory', `${this.config.memoryMb}m`);
    if (this.config.cpus !== undefined) args.push('--cpus', String(this.config.cpus));
    if (this.config.pidsLimit !== undefined) args.push('--pids-limit', String(this.config.pidsLimit));

    if (this.secretsMode === 'tmpfs') {
      // In-RAM tmpfs: secrets never land in the image, on disk, or in docker inspect Config.Env.
      // Always mount the dir so per-exec (stage) secrets work even without constructor secrets.
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
      throw new SandboxError(`Failed to start container ${this.name}`, { cause });
    }

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // Write the secrets file via stdin (umask 077) so the value never appears in argv.
      const write = await execa('docker', ['exec', '-i', this.name, 'sh', '-c', `umask 077; cat > ${SECRETS_FILE}`], {
        reject: false,
        input: shellBody(this.secrets),
      });
      if (write.exitCode !== 0) {
        await this.destroy();
        throw new SandboxError(`Failed to write secrets to tmpfs: ${write.stderr}`);
      }
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const hasStageSecrets = options.secrets !== undefined && Object.keys(options.secrets).length > 0;

    if (hasStageSecrets) {
      // Per-exec secrets require tmpfs so the stage file lands in RAM, not on disk or in argv.
      if (this.secretsMode !== 'tmpfs') {
        throw new SandboxError('Per-exec secrets require secretsMode "tmpfs"');
      }
      // options.secrets is defined and non-empty — narrowed by hasStageSecrets check above.
      const stageSecrets = options.secrets as Record<string, string>;
      validateSecrets(stageSecrets);
      // Write the stage secrets file via stdin (umask 077) — value never appears in argv.
      const write = await execa(
        'docker',
        ['exec', '-i', this.name, 'sh', '-c', `umask 077; cat > ${STAGE_SECRETS_FILE}`],
        { reject: false, input: shellBody(stageSecrets) },
      );
      if (write.exitCode !== 0) {
        throw new SandboxError(`Failed to write stage secrets to tmpfs: ${write.stderr}`);
      }
    }

    const { envArgs, wrapped } = this.envAndWrap(command, options, hasStageSecrets);
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    args.push(...envArgs);
    if (options.input !== undefined) args.push('-i');
    // Only source the stage file when this exec actually wrote one — prevents stale
    // stage files from a failed prior exec from bleeding secrets into later no-secret execs.
    args.push(this.name, 'sh', '-lc', wrapped);

    try {
      const result = await execa('docker', args, {
        reject: false,
        ...(options.input !== undefined ? { input: options.input } : {}),
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
    } finally {
      if (hasStageSecrets) {
        await execa('docker', ['exec', this.name, 'sh', '-c', `rm -f ${STAGE_SECRETS_FILE}`], { reject: false });
      }
    }
  }

  execStream(command: string, options: ExecOptions = {}): ExecStream {
    if (options.secrets !== undefined && Object.keys(options.secrets).length > 0) {
      throw new SandboxError('execStream does not support per-exec secrets; use exec()');
    }
    const { envArgs, wrapped } = this.envAndWrap(command, options, false);
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    args.push(...envArgs);
    args.push(this.name, 'sh', '-lc', wrapped);
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

  /** uid:gid of the container's run user, so copied files can be chowned to it (memoised). */
  private async containerOwner(): Promise<string> {
    if (this.owner === undefined) {
      const res = await execa('docker', ['exec', this.name, 'sh', '-c', 'printf "%s:%s" "$(id -u)" "$(id -g)"']);
      this.owner = res.stdout.trim();
    }
    return this.owner;
  }

  async copyIn(hostPath: string, sandboxPath: string): Promise<void> {
    try {
      const isDir = (await stat(hostPath)).isDirectory();
      await execa('docker', ['exec', this.name, 'mkdir', '-p', isDir ? sandboxPath : dirname(sandboxPath)]);
      const src = isDir ? `${hostPath}/.` : hostPath;
      await execa('docker', ['cp', src, `${this.name}:${sandboxPath}`]);
      // docker cp preserves host uid/gid, so chown to the container user; otherwise the non-root
      // agent cannot edit copied files (only create new ones).
      await execa('docker', ['exec', '-u', '0', this.name, 'chown', '-R', await this.containerOwner(), sandboxPath]);
    } catch (cause) {
      throw new SandboxError(`copyIn failed: ${hostPath} -> ${sandboxPath}`, { cause });
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
      throw new SandboxError(`copyFileOut failed: ${sandboxPath} -> ${hostPath}`, { cause });
    }
  }

  async exists(sandboxPath: string): Promise<boolean> {
    const result = await execa('docker', ['exec', this.name, 'test', '-e', sandboxPath], { reject: false });
    return result.exitCode === 0;
  }

  shellCommand(): string {
    return `docker exec -it ${this.name} bash`;
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
