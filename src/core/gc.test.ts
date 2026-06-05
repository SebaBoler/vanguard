import { describe, it, expect } from 'vitest';
import { reapContainers } from './gc.js';
import type { ContainerInfo } from './gc.js';

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
