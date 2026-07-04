import { describe, it, expect } from 'vitest';
import { sandboxResourceLimits, sandboxSecurityOpts, sidecarMemoryArgs } from './limits.js';

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

describe('sandboxSecurityOpts', () => {
  it('defaults to cap-drop ALL, the chown trio added back, no-new-privileges, readonly off', () => {
    expect(sandboxSecurityOpts({})).toEqual({
      capDrop: ['ALL'],
      capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
      noNewPrivileges: true,
      readOnlyRootfs: false,
    });
  });

  it('omits no-new-privileges when VANGUARD_SANDBOX_NO_NEW_PRIVILEGES=0', () => {
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_NO_NEW_PRIVILEGES: '0' } as NodeJS.ProcessEnv).noNewPrivileges).toBe(
      false,
    );
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_NO_NEW_PRIVILEGES: '' } as NodeJS.ProcessEnv).noNewPrivileges).toBe(
      false,
    );
  });

  it('omits cap-drop when VANGUARD_SANDBOX_CAP_DROP is empty', () => {
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_CAP_DROP: '' } as NodeJS.ProcessEnv).capDrop).toEqual([]);
  });

  it('respects a custom VANGUARD_SANDBOX_CAP_ADD list', () => {
    expect(
      sandboxSecurityOpts({ VANGUARD_SANDBOX_CAP_ADD: 'NET_BIND_SERVICE, SETGID' } as NodeJS.ProcessEnv).capAdd,
    ).toEqual(['NET_BIND_SERVICE', 'SETGID']);
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_CAP_ADD: '' } as NodeJS.ProcessEnv).capAdd).toEqual([]);
  });

  it('enables readOnlyRootfs only when VANGUARD_SANDBOX_READONLY is set truthy', () => {
    expect(sandboxSecurityOpts({}).readOnlyRootfs).toBe(false);
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_READONLY: '1' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(true);
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_READONLY: 'true' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(true);
    expect(sandboxSecurityOpts({ VANGUARD_SANDBOX_READONLY: '0' } as NodeJS.ProcessEnv).readOnlyRootfs).toBe(false);
  });
});

describe('sidecarMemoryArgs', () => {
  it('defaults to 256m', () => {
    expect(sidecarMemoryArgs({})).toEqual(['--memory', '256m']);
  });
  it('overrides with VANGUARD_SIDECAR_MEMORY_MB', () => {
    expect(sidecarMemoryArgs({ VANGUARD_SIDECAR_MEMORY_MB: '128' } as NodeJS.ProcessEnv)).toEqual(['--memory', '128m']);
  });
  it('omits the cap on 0 / invalid', () => {
    expect(sidecarMemoryArgs({ VANGUARD_SIDECAR_MEMORY_MB: '0' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(sidecarMemoryArgs({ VANGUARD_SIDECAR_MEMORY_MB: 'off' } as NodeJS.ProcessEnv)).toEqual([]);
  });
});
