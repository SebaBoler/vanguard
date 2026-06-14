import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryCommand } from './memory.js';

const FAILED_RUN_LINE = JSON.stringify({
  evt: 'run_complete',
  ts: '2026-06-06T10:00:00.000Z',
  taskId: 'TES-1',
  exitReason: 'error',
  completed: false,
  turns: 1,
});

async function seedRepo(tmp: string): Promise<void> {
  const runsDir = join(tmp, '.vanguard', 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, 'metrics.jsonl'), FAILED_RUN_LINE + '\n', 'utf8');
}

describe('memoryCommand', () => {
  const tmps: string[] = [];

  afterEach(async () => {
    for (const tmp of tmps.splice(0)) {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  async function makeTmp(): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), 'vg-memory-'));
    tmps.push(tmp);
    return tmp;
  }

  it('writes .vanguard/memory/retrospective.md on default (non-json) invocation', async () => {
    const tmp = await makeTmp();
    await seedRepo(tmp);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await memoryCommand({ kind: 'memory', repoPath: tmp, json: false });
    } finally {
      console.log = origLog;
    }

    // File must exist
    const mdPath = join(tmp, '.vanguard', 'memory', 'retrospective.md');
    await expect(access(mdPath)).resolves.toBeUndefined();
  });

  it('prints JSON report containing the seeded entry when --json is true', async () => {
    const tmp = await makeTmp();
    await seedRepo(tmp);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await memoryCommand({ kind: 'memory', repoPath: tmp, json: true });
    } finally {
      console.log = origLog;
    }

    const firstLine = logs[0];
    expect(firstLine).toBeDefined();
    const parsed = JSON.parse(firstLine!) as { entries: Array<{ taskId: string }> };
    expect(parsed.entries.some((e) => e.taskId === 'TES-1')).toBe(true);

    // File must also be written in the --json path
    const mdPath = join(tmp, '.vanguard', 'memory', 'retrospective.md');
    await expect(access(mdPath)).resolves.toBeUndefined();
  });
});
