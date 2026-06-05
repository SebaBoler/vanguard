export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecStream {
  stdout: AsyncIterable<string>;
  result: Promise<ExecResult>;
}

/**
 * A fully isolated execution environment (Docker container or Firecracker microVM).
 * The host owns explicit file sync: nothing crosses the boundary except via copyIn/copyFileOut.
 */
export interface IsolatedSandboxProvider {
  readonly id: string;
  /** Provision the sandbox (pull image / boot VM, start it). */
  start: () => Promise<void>;
  /** Run a command INSIDE the sandbox and capture output (never throws on non-zero exit). */
  exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;
  /** Stream a long-running command's stdout while it runs (for live logging / abort). */
  execStream: (command: string, options?: ExecOptions) => ExecStream;
  /** Copy a host file/dir INTO the sandbox. */
  copyIn: (hostPath: string, sandboxPath: string) => Promise<void>;
  /** Copy a sandbox file/dir OUT to the host. */
  copyFileOut: (sandboxPath: string, hostPath: string) => Promise<void>;
  /** True if a path exists inside the sandbox. */
  exists: (sandboxPath: string) => Promise<boolean>;
  /** Tear down (rm container / kill VM). Safe to call multiple times. */
  destroy: () => Promise<void>;
}

export interface SandboxConfig {
  image?: string;
  workdir?: string;
  env?: Record<string, string>;
  forwardEnv?: string[];
  /** Secrets injected off the command line (env-file / stdin), never via -e KEY=VAL. */
  secrets?: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}
