import { describe, it, expect } from 'vitest';
import { reapContainers, reapEgressNetworks, reapRemoteBranches } from './gc.js';
import type { ContainerInfo, RemoteBranchInfo } from './gc.js';

describe('reapContainers', () => {
  it('removes only containers older than maxAge', async () => {
    const containers: ContainerInfo[] = [
      { id: 'old', ageMs: 10_000 },
      { id: 'fresh', ageMs: 100 },
    ];
    const removed: string[] = [];
    const result = await reapContainers(
      async () => containers,
      async (id) => {
        removed.push(id);
      },
      1_000,
    );
    expect(result).toEqual(['old']);
    expect(removed).toEqual(['old']);
  });

  it('removes nothing when all containers are fresh', async () => {
    const result = await reapContainers(
      async () => [{ id: 'a', ageMs: 5 }],
      async () => {},
      1_000,
    );
    expect(result).toEqual([]);
  });
});

describe('reapEgressNetworks', () => {
  it('removes all listed orphaned networks', async () => {
    const removed: string[] = [];
    const result = await reapEgressNetworks(
      async () => ['vg-egr-abc123', 'vg-egr-def456'],
      async (name) => {
        removed.push(name);
      },
    );
    expect(result).toEqual(['vg-egr-abc123', 'vg-egr-def456']);
    expect(removed).toEqual(['vg-egr-abc123', 'vg-egr-def456']);
  });

  it('returns empty array when no orphaned networks', async () => {
    const result = await reapEgressNetworks(async () => [], async () => {});
    expect(result).toEqual([]);
  });
});

describe('reapRemoteBranches', () => {
  it('removes only aged branches whose PR was merged', async () => {
    const branches: RemoteBranchInfo[] = [
      { name: 'vanguard/old-merged', ageMs: 10_000 },
      { name: 'vanguard/old-unmerged', ageMs: 10_000 },
      { name: 'vanguard/fresh', ageMs: 100 },
    ];
    const removed: string[] = [];
    const result = await reapRemoteBranches(
      async () => branches,
      async (name) => name === 'vanguard/old-merged',
      async (name) => {
        removed.push(name);
      },
      1_000,
    );
    expect(result).toEqual(['vanguard/old-merged']);
    expect(removed).toEqual(['vanguard/old-merged']);
  });

  it('does not check the merge state of fresh branches', async () => {
    const checked: string[] = [];
    const result = await reapRemoteBranches(
      async () => [{ name: 'vanguard/fresh', ageMs: 5 }],
      async (name) => {
        checked.push(name);
        return true;
      },
      async () => {},
      1_000,
    );
    expect(result).toEqual([]);
    expect(checked).toEqual([]);
  });
});
