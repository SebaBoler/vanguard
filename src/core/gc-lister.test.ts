import { describe, it, expect, vi } from 'vitest';

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa }));

const { dockerEgressNetworkLister } = await import('./gc.js');

describe('dockerEgressNetworkLister', () => {
  it('skips a network removed between ls and inspect, and warns only about unparseable output', async () => {
    const now = 1_000_000_000_000;
    const old = String(Math.floor(now / 1000) - 3600);
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[1] === 'ls') return { stdout: 'vg-egr-gone\nvg-egr-legacy\nvg-egr-stale\nvg-egr-weird' };
      const byName: Record<string, { stdout: string; stderr: string; exitCode: number }> = {
        'vg-egr-gone': { stdout: '', stderr: 'Error response from daemon: network vg-egr-gone not found', exitCode: 1 },
        'vg-egr-legacy': { stdout: '', stderr: 'Error: No such network: vg-egr-legacy', exitCode: 1 },
        'vg-egr-stale': { stdout: `0 ${old}`, stderr: '', exitCode: 0 },
        'vg-egr-weird': { stdout: 'template: bad', stderr: '', exitCode: 0 },
      };
      return byName[args[2] ?? ''];
    });
    const warnings: string[] = [];

    const stale = await dockerEgressNetworkLister(60_000, () => now, (line) => warnings.push(line))();

    expect(stale).toEqual(['vg-egr-stale']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('vg-egr-weird');
    expect(warnings[0]).not.toContain('vg-egr-gone');
    expect(warnings[0]).not.toContain('vg-egr-legacy');
  });
});
