import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDraftPath, WatchRegistry } from './watch.js';

// Captured before any `vi.useFakeTimers()` call so the polling-mode tests can force a genuine
// wall-clock wait for real fs I/O to settle, independent of the faked `setTimeout`/`setInterval`.
const realSetTimeout = globalThis.setTimeout;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vanguard-hub-watch-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

/** Real-timer wait past the 300ms debounce, generous for CI jitter. */
async function waitPastDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Give real fs I/O (the polling fallback's fingerprint reads) a genuine wall-clock chance to
 * settle. Uses the pre-captured native `setTimeout` so this is a real wait rather than a count of
 * synthetic ticks — counting ticks raced the thread pool under load and was flaky.
 */
async function flushAsync(ms = 100): Promise<void> {
  await new Promise((resolve) => realSetTimeout(resolve, ms));
}

describe('isDraftPath', () => {
  it('matches structurally, with adjacency required', () => {
    expect(isDraftPath('/r/.vanguard/drafts/draft-a.json')).toBe(true);
    expect(isDraftPath('/r/.vanguard/drafts/.gitignore')).toBe(true);
    expect(isDraftPath('/r/.vanguard/runs/x.json')).toBe(false);
    expect(isDraftPath('/r/drafts/.vanguard/x')).toBe(false);
    expect(isDraftPath('/r/src/drafts/a.json')).toBe(false);
    expect(isDraftPath('/r/.vanguard')).toBe(false);
  });
});

describe('WatchRegistry — fs.watch mode', () => {
  it('T-71: a write under .vanguard/runs causes exactly one debounced onChange with the right repoPath', async () => {
    await mkdir(join(tmp, '.vanguard', 'runs'), { recursive: true });
    const registry = new WatchRegistry();
    const onChange = vi.fn();
    registry.watchProject(tmp, onChange);

    await write(join(tmp, '.vanguard', 'runs', 'task-1', 'run.json'), '{}');
    await write(join(tmp, '.vanguard', 'runs', 'task-1', 'run.json'), '{"a":1}');

    await waitPastDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(tmp);

    registry.closeAll();
  });

  it('T-72: drafts-only bursts are suppressed; a mixed burst with a non-draft path triggers', async () => {
    await mkdir(join(tmp, '.vanguard', 'drafts'), { recursive: true });
    await mkdir(join(tmp, '.vanguard', 'runs'), { recursive: true });
    const registry = new WatchRegistry();
    const onChange = vi.fn();
    registry.watchProject(tmp, onChange);

    await write(join(tmp, '.vanguard', 'drafts', 'draft-a.json'), '{}');
    await write(join(tmp, '.vanguard', 'drafts', '.gitignore'), '*');

    await waitPastDebounce();
    expect(onChange).not.toHaveBeenCalled();

    await Promise.all([
      write(join(tmp, '.vanguard', 'drafts', 'draft-b.json'), '{}'),
      write(join(tmp, '.vanguard', 'runs', 'task-2', 'run.json'), '{}'),
    ]);

    await waitPastDebounce();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(tmp);

    registry.closeAll();
  });

  it('T-73: re-watchProject replaces (no duplicate callbacks); unwatchProject stops further callbacks', async () => {
    await mkdir(join(tmp, '.vanguard', 'runs'), { recursive: true });
    const registry = new WatchRegistry();
    const onChange = vi.fn();
    registry.watchProject(tmp, onChange);
    registry.watchProject(tmp, onChange); // replace — must not stack a second watcher

    await write(join(tmp, '.vanguard', 'runs', 'task-3', 'run.json'), '{}');
    await waitPastDebounce();
    expect(onChange).toHaveBeenCalledTimes(1);

    registry.unwatchProject(tmp);
    onChange.mockClear();

    await write(join(tmp, '.vanguard', 'runs', 'task-3', 'run2.json'), '{}');
    await waitPastDebounce();
    expect(onChange).not.toHaveBeenCalled();

    registry.closeAll();
  });
});

describe('WatchRegistry — polling mode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-74: forcePoll detects a new run record file once the fingerprint changes', async () => {
    await mkdir(join(tmp, '.vanguard', 'runs'), { recursive: true });
    const registry = new WatchRegistry({ forcePoll: true, pollIntervalMs: 2000 });
    const onChange = vi.fn();

    registry.watchProject(tmp, onChange);
    await flushAsync(); // let the immediate baseline poll settle before anything changes

    await write(join(tmp, '.vanguard', 'runs', 'task-4', 'run.json'), '{}');

    vi.advanceTimersByTime(2000);
    await flushAsync();

    expect(onChange).toHaveBeenCalledWith(tmp);

    registry.closeAll();
  });

  it('T-75: a synchronous fs.watch setup failure falls back to polling instead of throwing', async () => {
    const missingRepo = join(tmp, 'not-created-yet');
    const registry = new WatchRegistry({ pollIntervalMs: 2000 });
    const onChange = vi.fn();

    expect(() => registry.watchProject(missingRepo, onChange)).not.toThrow();
    await flushAsync();

    // The repo (and a run) appears later — the polling fallback should still pick it up.
    await write(join(missingRepo, '.vanguard', 'runs', 'task-5', 'run.json'), '{}');

    vi.advanceTimersByTime(2000);
    await flushAsync();

    expect(onChange).toHaveBeenCalledWith(missingRepo);

    registry.closeAll();
  });
});
