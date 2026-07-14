import { describe, expect, it } from 'vitest';
import { columnFor, mintBoardId, resolveTaskRef, toBoardTask } from './board.js';
import { boardFilterFor, BOARD_FETCH_CAP, fetchTaskSpec, listBoardTasks, readBoardConfig } from './board-list.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskFetcher } from './fetcher.js';

// ── columnFor: the tasks.rs test table, ported verbatim (S9 spec §2.6 / AC 1) ──────────────────
describe('columnFor (Rust table 1:1)', () => {
  it.each([
    ['vanguard:running', 'running'],
    ['vanguard:needs-human-review', 'review'],
    ['vanguard::verify-failed', 'verify-failed'],
    ['vanguard::secret-blocked', 'verify-failed'],
    ['vanguard:speccing', 'claimed'],
    ['Speccing', 'claimed'],
    ['Done', 'done'],
    ['closed', 'done'],
    ['In Progress', 'claimed'],
    ['Todo', 'queued'],
    // A terminal state wins over a stale active label.
    ['vanguard:running closed', 'done'],
    // A generic dependency-`blocked` label is NOT a verify failure.
    ['blocked', 'queued'],
    // Whole-token matching: adjacent vocabulary must NOT collide with a keyword substring.
    ['incomplete', 'queued'],
    ['preview', 'queued'],
    ['inspection', 'queued'],
    ['In Review', 'review'],
    ['vanguard::reviewing', 'review'],
    ['vanguard::reviewed', 'review'],
    ['completed', 'done'],
  ])('%s → %s', (text, column) => {
    expect(columnFor(text)).toBe(column);
  });
});

// ── mint + resolve round-trip, incl. the run-record sanitized form (spec §2.4) ──────────────────
describe('mintBoardId / resolveTaskRef', () => {
  it.each([
    ['github', '904', 'gh-904'],
    ['gitlab', '42', 'gl-42'],
    ['linear', 'DEV-639', 'linear-dev-639'],
  ] as const)('%s %s mints %s and resolves back', (source, ref, id) => {
    expect(mintBoardId(source, ref)).toBe(id);
    expect(resolveTaskRef(id)).toEqual({ source, reference: ref });
  });

  it('resolves RUN-RECORD ids (sanitized full slug) via trailing-number semantics — RunDetail depends on it', () => {
    expect(resolveTaskRef('gh-owner-repo-904')).toEqual({ source: 'github', reference: '904' });
    expect(resolveTaskRef('gl-group-proj-5')).toEqual({ source: 'gitlab', reference: '5' });
  });

  it('unrecognized forms are undefined (taskid.rs table)', () => {
    expect(resolveTaskRef('owner/repo#weird')).toBeUndefined();
    expect(resolveTaskRef('spec-gh-211')).toBeUndefined();
    expect(resolveTaskRef('linear-')).toBeUndefined();
    expect(resolveTaskRef('gh-')).toBeUndefined();
  });
});

// ── chip rule per provider (spec §2.6 — the labels-present Linear case the old table missed) ────
describe('toBoardTask chips', () => {
  const base: Task = { id: 'x', title: 'T', description: '', labels: [], children: [], comments: [] };

  it('github/gitlab: first label else provider state', () => {
    expect(toBoardTask('github', { ...base, ref: '904', state: 'open', labels: ['vanguard:running'] }).state).toBe('vanguard:running');
    expect(toBoardTask('github', { ...base, ref: '904', state: 'open' }).state).toBe('open');
    expect(toBoardTask('gitlab', { ...base, ref: '5', state: 'opened', labels: ['vanguard::verify-failed'] })).toMatchObject({
      id: 'gl-5',
      column: 'verify-failed',
      state: 'vanguard::verify-failed',
    });
  });

  it('linear: ALWAYS the workflow state, even with labels present (the chip the ported table missed)', () => {
    const t = toBoardTask('linear', { ...base, ref: 'DEV-700', state: 'In Progress', labels: ['vanguard::verify-failed'] });
    expect(t.state).toBe('In Progress'); // chip = workflow state
    expect(t.column).toBe('verify-failed'); // column = label overrides state
  });

  it('linear id mints from the identifier, lowercased, resolving back (tasks.rs linear_task test)', () => {
    const t = toBoardTask('linear', { ...base, ref: 'DEV-639', state: 'In Progress' });
    expect(t.id).toBe('linear-dev-639');
    expect(resolveTaskRef(t.id)).toEqual({ source: 'linear', reference: 'DEV-639' });
    expect(t.column).toBe('claimed');
  });
});

// ── the board filter: state per source (spec §2.2 — Linear 'all' would silently empty the board) ─
describe('boardFilterFor', () => {
  it("github/gitlab get state:'all' (Done fills from closed — the glab parity change)", () => {
    expect(boardFilterFor('github')).toEqual({ state: 'all', limit: BOARD_FETCH_CAP });
    expect(boardFilterFor('gitlab', 'vanguard')).toEqual({ state: 'all', limit: BOARD_FETCH_CAP, labels: ['vanguard'] });
  });

  it('linear gets NO state filter — a workflow-state-TYPE eq of "all" matches nothing', () => {
    const filter = boardFilterFor('linear');
    expect('state' in filter).toBe(false);
    expect(filter.limit).toBe(BOARD_FETCH_CAP);
  });
});

// ── listBoardTasks over an injected fetcher ─────────────────────────────────────────────────────
describe('listBoardTasks', () => {
  async function repoWith(config: unknown): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'vg-board-'));
    await mkdir(join(repo, '.vanguard'), { recursive: true });
    await writeFile(join(repo, '.vanguard', 'app.json'), JSON.stringify(config));
    return repo;
  }
  const fake = (tasks: Task[]): TaskFetcher => ({
    fetch: async () => tasks[0]!,
    list: async () => tasks,
  });

  it('no source → the actionable Settings prompt (never a github default)', async () => {
    const repo = await repoWith({});
    await expect(listBoardTasks(repo)).rejects.toThrow(/Set a Task Source in Settings/);
  });

  it('maps fetched tasks through toBoardTask and reports capped at the fetch cap', async () => {
    const repo = await repoWith({ source: 'github' });
    const tasks: Task[] = Array.from({ length: BOARD_FETCH_CAP }, (_, i) => ({
      id: `o/r#${i}`, title: `t${i}`, description: '', labels: [], children: [], comments: [], ref: String(i), state: 'open',
    }));
    const { tasks: board, capped } = await listBoardTasks(repo, async () => fake(tasks));
    expect(board).toHaveLength(BOARD_FETCH_CAP);
    expect(board[3]).toEqual({ id: 'gh-3', title: 't3', column: 'queued', state: 'open' });
    expect(capped).toBe(true);
  });

  it('under the cap is not capped', async () => {
    const repo = await repoWith({ source: 'linear', team: 'DEV' });
    const one: Task = { id: 'DEV-1', title: 'a', description: '', labels: [], children: [], comments: [], ref: 'DEV-1', state: 'Todo' };
    const { capped, tasks } = await listBoardTasks(repo, async () => fake([one]));
    expect(capped).toBe(false);
    expect(tasks[0]).toEqual({ id: 'linear-dev-1', title: 'a', column: 'queued', state: 'Todo' });
  });
});

describe('readBoardConfig', () => {
  it('missing file / unreadable JSON / non-object ⇒ {} (passive read, desktop parity)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'vg-none-'));
    expect(await readBoardConfig(bare)).toEqual({});
    const repo = await mkdtemp(join(tmpdir(), 'vg-bad-'));
    await mkdir(join(repo, '.vanguard'), { recursive: true });
    await writeFile(join(repo, '.vanguard', 'app.json'), '{not json');
    expect(await readBoardConfig(repo)).toEqual({});
  });
});

// review #346 obs 1: the flag-smuggling guard is the one argv-safety check here — pin it.
describe('fetchTaskSpec guards (no exec reaches a bad id)', () => {
  it('rejects a flag-shaped Linear id before any CLI spawn (linear--version → -VERSION)', async () => {
    await expect(fetchTaskSpec('/nonexistent', 'linear--version')).rejects.toThrow(/Invalid Linear id/);
  });

  it('rejects a hyphen-less Linear reference (not an identifier shape)', async () => {
    await expect(fetchTaskSpec('/nonexistent', 'linear-devonly')).rejects.toThrow(/Invalid Linear id/);
  });

  it('rejects an unresolvable id with the prefix guidance', async () => {
    await expect(fetchTaskSpec('/nonexistent', 'owner/repo#weird')).rejects.toThrow(/Recognized prefixes/);
  });
});
