import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ipc from '../../ipc.js';
import { DraftWriter, draftLabel, mintDraftId, parseDraft, type DraftData } from './draftStore.js';

vi.mock('../../ipc.js', () => ({
  readDraft: vi.fn(),
  writeDraft: vi.fn(async () => {}),
  deleteDraft: vi.fn(async () => {}),
}));

beforeEach(() => {
  // reset (not clear): per-test mockImplementations must not leak into the next test.
  vi.resetAllMocks();
  vi.mocked(ipc.writeDraft).mockResolvedValue(undefined);
  vi.mocked(ipc.deleteDraft).mockResolvedValue(undefined);
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const draft = (over: Partial<DraftData> = {}): DraftData => ({
  body: '',
  chat: [],
  archived: false,
  updatedAt: '',
  ...over,
});

// ── id + parsing ────────────────────────────────────────────────────────────────────────────────

test('mintDraftId stays inside the Rust write grammar and does not collide within one millisecond', () => {
  const a = mintDraftId();
  const b = mintDraftId();
  expect(a).toMatch(/^draft-[a-z0-9]+-[a-z0-9]{6}$/);
  expect(a).not.toBe(b); // entropy suffix — same-ms mints must differ
});

test('parseDraft roundtrips a valid draft', () => {
  const d = draft({ body: '# x', chat: [{ role: 'user', content: 'hi' }], archived: true, created: { id: 'gh-1', url: 'https://g/1' } });
  expect(parseDraft(JSON.stringify(d))).toEqual(d);
});

test('parseDraft rejects garbage, bad chat shapes, and non-http created urls', () => {
  expect(parseDraft('{not json')).toBeUndefined();
  expect(parseDraft('null')).toBeUndefined();
  expect(parseDraft(JSON.stringify({ body: 1, chat: [] }))).toBeUndefined();
  expect(parseDraft(JSON.stringify({ body: '', chat: [{ role: 'system', content: 'x' }] }))).toBeUndefined();
  // A committed draft in a cloned repo must not smuggle a javascript: URL into the link chip.
  expect(parseDraft(JSON.stringify(draft({ created: { id: 'x', url: 'javascript:alert(1)' } })))).toBeUndefined();
  expect(parseDraft(JSON.stringify(draft({ created: { id: 'x', url: 'file:///etc' } })))).toBeUndefined();
});

test('parseDraft coerces created ⇒ archived — a hand-edited file cannot re-enable Create task on a filed draft', () => {
  const parsed = parseDraft(JSON.stringify(draft({ archived: false, created: { id: 'gh-1', url: 'https://g/1' } })));
  expect(parsed?.archived).toBe(true);
});

test('draftLabel: heading, then first user chat message, then Untitled', () => {
  expect(draftLabel(draft({ body: '# Fix flicker\n' }))).toBe('Fix flicker');
  expect(draftLabel(draft({ chat: [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'plan the flicker fix' }] }))).toBe(
    'plan the flicker fix',
  );
  expect(draftLabel(draft({ chat: [{ role: 'user', content: 'x'.repeat(80) }] }))).toBe(`${'x'.repeat(60)}…`);
  expect(draftLabel(draft())).toBe('Untitled');
});

// ── DraftWriter ────────────────────────────────────────────────────────────────────────────────

test('schedule writes the SNAPSHOT it was armed with — mutating the passed object later cannot alias (review #349 r2)', async () => {
  const w = new DraftWriter('/repo', () => {});
  const armed = draft({ body: 'outgoing' });
  w.schedule('draft-a', armed);
  // A draft switch mutates/repoints the component's live state before the flush's microtask runs;
  // the armed snapshot must be immune to it.
  armed.body = 'incoming';
  await w.flush();
  expect(ipc.writeDraft).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(ipc.writeDraft).mock.calls[0][2]).body).toBe('outgoing');
});

test('writeNow supersedes an armed debounce — the older body snapshot cannot land last', async () => {
  const w = new DraftWriter('/repo', () => {});
  w.schedule('draft-a', draft({ body: 'older' }));
  await w.writeNow('draft-a', draft({ body: 'newer' }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(ipc.writeDraft).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(ipc.writeDraft).mock.calls[0][2]).body).toBe('newer');
});

test('re-arming replaces the timer — one write per burst', async () => {
  const w = new DraftWriter('/repo', () => {});
  w.schedule('draft-a', draft({ body: '1' }));
  await vi.advanceTimersByTimeAsync(500);
  w.schedule('draft-a', draft({ body: '12' }));
  await vi.advanceTimersByTimeAsync(800);
  expect(ipc.writeDraft).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(ipc.writeDraft).mock.calls[0][2]).body).toBe('12');
});

test('discard drops a pending debounce without writing', async () => {
  const w = new DraftWriter('/repo', () => {});
  w.schedule('draft-a', draft());
  w.discard('draft-a');
  await vi.advanceTimersByTimeAsync(2000);
  expect(ipc.writeDraft).not.toHaveBeenCalled();
});

test('flush fires the armed debounce immediately and resolves after the write lands', async () => {
  const w = new DraftWriter('/repo', () => {});
  w.schedule('draft-a', draft({ body: 'x' }));
  expect(w.dirty()).toBe(true);
  await w.flush();
  expect(ipc.writeDraft).toHaveBeenCalledTimes(1);
  expect(w.dirty()).toBe(false);
});

test('writes to one id are serialized in issue order even when the backend is slow', async () => {
  const landed: string[] = [];
  vi.mocked(ipc.writeDraft).mockImplementation(async (_p, _id, content) => {
    const body = (JSON.parse(content) as DraftData).body;
    // First write is slow; without the per-id chain the second would land first.
    if (body === 'first') await new Promise((r) => setTimeout(r, 100));
    landed.push(body);
  });
  const w = new DraftWriter('/repo', () => {});
  void w.writeNow('draft-a', draft({ body: 'first' }));
  void w.writeNow('draft-a', draft({ body: 'second' }));
  await vi.advanceTimersByTimeAsync(200);
  await w.flush();
  expect(landed).toEqual(['first', 'second']);
});

test('deleteNow cancels the pending debounce and wins over an in-flight write — no resurrection', async () => {
  const events: string[] = [];
  vi.mocked(ipc.writeDraft).mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 50)); // in flight when the delete is requested
    events.push('write');
  });
  vi.mocked(ipc.deleteDraft).mockImplementation(async () => {
    events.push('delete');
  });
  const w = new DraftWriter('/repo', () => {});
  void w.writeNow('draft-a', draft());
  w.schedule('draft-a', draft()); // an armed timer that must NOT fire after the delete
  void w.deleteNow('draft-a');
  await vi.advanceTimersByTimeAsync(2000);
  await w.flush();
  expect(events).toEqual(['write', 'delete']); // delete queued after the write it supersedes — file ends gone
});

test('update read-modify-writes the target draft', async () => {
  vi.mocked(ipc.readDraft).mockResolvedValue(JSON.stringify(draft({ body: 'kept', chat: [{ role: 'user', content: 'q' }] })));
  const w = new DraftWriter('/repo', () => {});
  const outcome = await w.update('draft-a', (d) => ({ ...d, archived: true }));
  expect(outcome).toBe('written');
  const written = JSON.parse(vi.mocked(ipc.writeDraft).mock.calls[0][2]) as DraftData;
  expect(written.archived).toBe(true);
  expect(written.body).toBe('kept');
  expect(written.chat).toEqual([{ role: 'user', content: 'q' }]);
});

test('update SKIPS a missing or unreadable file — an id-keyed append must never resurrect a deleted draft', async () => {
  vi.mocked(ipc.readDraft).mockRejectedValue(new Error('missing'));
  const w = new DraftWriter('/repo', () => {});
  expect(await w.update('draft-gone', (d) => d)).toBe('skipped');
  vi.mocked(ipc.readDraft).mockResolvedValue('{corrupt');
  expect(await w.update('draft-corrupt', (d) => d)).toBe('skipped');
  expect(ipc.writeDraft).not.toHaveBeenCalled();
  // A write that actually fails is 'failed', not 'skipped' — the do-not-re-file copy keys on it.
  vi.mocked(ipc.readDraft).mockResolvedValue(JSON.stringify(draft()));
  vi.mocked(ipc.writeDraft).mockRejectedValueOnce(new Error('disk full'));
  expect(await w.update('draft-a', (d) => d)).toBe('failed');
});

test('a failed write reports the error, resolves false, and does not break the chain', async () => {
  const errors: string[] = [];
  vi.mocked(ipc.writeDraft).mockRejectedValueOnce(new Error('disk full'));
  const w = new DraftWriter('/repo', (m) => errors.push(m));
  const first = await w.writeNow('draft-a', draft());
  const second = await w.writeNow('draft-a', draft({ body: 'later' }));
  expect(first).toBe(false);
  expect(second).toBe(true);
  expect(errors[0]).toMatch(/disk full/);
  expect(ipc.writeDraft).toHaveBeenCalledTimes(2);
});

test('every write stamps updatedAt', async () => {
  const w = new DraftWriter('/repo', () => {});
  await w.writeNow('draft-a', draft());
  const written = JSON.parse(vi.mocked(ipc.writeDraft).mock.calls[0][2]) as DraftData;
  expect(Number.isNaN(Date.parse(written.updatedAt))).toBe(false);
});
