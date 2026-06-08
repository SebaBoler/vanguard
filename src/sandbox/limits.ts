import type { SandboxConfig } from './provider.js';

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
