import type { SandboxConfig, SandboxSecurityOpts } from './provider.js';

export type SandboxResourceLimits = Pick<SandboxConfig, 'memoryMb' | 'cpus' | 'pidsLimit'>;

/**
 * Env-overridable sandbox resource limits. Defaults: memory 2048 MB, 2 CPUs, 512 pids. Each
 * VANGUARD_SANDBOX_* var overrides its default; set it to "0" (or an invalid/empty value) to OMIT
 * that limit entirely, so no `--memory`/`--cpus`/`--pids-limit` flag is passed. This is required on
 * hosts whose kernel lacks a cgroup — e.g. Synology DSM has no CPU CFS scheduler, so `--cpus` is
 * fatal there and must be disabled with VANGUARD_SANDBOX_CPUS=0.
 */
export function sandboxResourceLimits(env: NodeJS.ProcessEnv = process.env): SandboxResourceLimits {
  const limit = (name: string, fallback: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const memoryMb = limit('VANGUARD_SANDBOX_MEMORY_MB', 2048);
  const cpus = limit('VANGUARD_SANDBOX_CPUS', 2);
  const pidsLimit = limit('VANGUARD_SANDBOX_PIDS', 512);
  return {
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
    ...(pidsLimit !== undefined ? { pidsLimit } : {}),
  };
}

/**
 * `docker run` args capping a sidecar's memory (the egress and llm-proxy proxies). Default 256 MB,
 * overridable with VANGUARD_SIDECAR_MEMORY_MB; "0" (or invalid/empty) omits the cap. These proxies are
 * small node servers, but an unbounded container can still pressure a small host (e.g. a 5.6 GB NAS).
 */
export function sidecarMemoryArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.VANGUARD_SIDECAR_MEMORY_MB;
  const mb = raw === undefined ? 256 : Number(raw);
  return Number.isFinite(mb) && mb > 0 ? ['--memory', `${Math.floor(mb)}m`] : [];
}

/**
 * Env-overridable sandbox hardening. Unlike the resource limits above, these default ON for every
 * sandbox (least-privilege by default) and are overridable per the same "0"/empty ⇒ disable idiom.
 */
export function sandboxSecurityOpts(env: NodeJS.ProcessEnv = process.env): SandboxSecurityOpts {
  const list = (raw: string | undefined, fallback: string[]): string[] =>
    raw === undefined
      ? fallback
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  const flag = (raw: string | undefined, fallback: boolean): boolean =>
    raw === undefined ? fallback : !(raw === '0' || raw === '');
  return {
    capDrop: list(env.VANGUARD_SANDBOX_CAP_DROP, ['ALL']),
    capAdd: list(env.VANGUARD_SANDBOX_CAP_ADD, ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']),
    noNewPrivileges: flag(env.VANGUARD_SANDBOX_NO_NEW_PRIVILEGES, true),
    readOnlyRootfs: flag(env.VANGUARD_SANDBOX_READONLY, false),
  };
}
