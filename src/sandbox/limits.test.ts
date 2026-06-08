import { describe, it, expect } from 'vitest';
import { sandboxResourceLimits } from './limits.js';

describe('sandboxResourceLimits', () => {
  it('uses defaults when no env is set', () => {
    expect(sandboxResourceLimits({})).toEqual({ memoryMb: 2048, cpus: 2, pidsLimit: 512 });
  });

  it('omits cpus when VANGUARD_SANDBOX_CPUS=0 (kernel without CFS, e.g. Synology)', () => {
    const out = sandboxResourceLimits({ VANGUARD_SANDBOX_CPUS: '0' } as NodeJS.ProcessEnv);
    expect('cpus' in out).toBe(false);
    expect(out.memoryMb).toBe(2048);
    expect(out.pidsLimit).toBe(512);
  });

  it('overrides each limit with a positive value', () => {
    const out = sandboxResourceLimits({
      VANGUARD_SANDBOX_MEMORY_MB: '1536',
      VANGUARD_SANDBOX_CPUS: '1',
      VANGUARD_SANDBOX_PIDS: '256',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({ memoryMb: 1536, cpus: 1, pidsLimit: 256 });
  });

  it('omits a limit on an invalid or empty value', () => {
    expect('memoryMb' in sandboxResourceLimits({ VANGUARD_SANDBOX_MEMORY_MB: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect('pidsLimit' in sandboxResourceLimits({ VANGUARD_SANDBOX_PIDS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
