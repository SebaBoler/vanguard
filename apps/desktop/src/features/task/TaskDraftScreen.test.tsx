import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TaskDraftScreen } from './TaskDraftScreen.js';
import type { DraftData } from './draftStore.js';
import * as ipc from '../../ipc.js';

// In-memory draft store: the mocks behave like the Rust seam (write lands, read returns what was
// written, delete removes), so id-keyed read-modify-writes are exercised for real.
const files = new Map<string, string>();

vi.mock('../../ipc.js', () => ({
  listDrafts: vi.fn(async () => [...files.keys()]),
  readDraft: vi.fn(async (_p: string, id: string) => {
    const f = files.get(id);
    if (f === undefined) throw new Error('missing');
    return f;
  }),
  writeDraft: vi.fn(async (_p: string, id: string, content: string) => {
    files.set(id, content);
  }),
  deleteDraft: vi.fn(async (_p: string, id: string) => {
    files.delete(id);
  }),
  readAppConfig: vi.fn(async () => ({ source: 'github' })),
  apiComplete: vi.fn(async () => ({ text: 'ok' })),
  apiCreateTask: vi.fn(async () => ({ id: 'gh-7', url: 'https://github.com/o/r/issues/7' })),
}));

vi.mock('./DocEditor.js', () => ({
  DocEditor: ({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly?: boolean }) => (
    <textarea
      data-testid="editor"
      data-readonly={String(readOnly === true)}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// The screen keeps session memory (tabs / consumed nonce) at module level; isolate tests with a
// unique project per test and a strictly increasing nonce.
let proj = 0;
let nonce = 0;
const freshProject = (): string => `/repo-${++proj}`;

const seed = (id: string, data: Partial<DraftData>): void => {
  files.set(id, JSON.stringify({ body: '', chat: [], archived: false, updatedAt: '2026-07-14T10:00:00.000Z', ...data }));
};

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

// A fresh nonce ⇒ the loader treats the mount as a New Task click: fresh conversation, drawer
// open on the chat panel — so the composer and the strip are immediately reachable.
const renderFresh = (project = freshProject()): ReturnType<typeof render> =>
  render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);

const drawerReady = (): Promise<HTMLElement> => screen.findByLabelText('new conversation');
const toHistory = (): void => {
  fireEvent.click(screen.getByLabelText('history'));
};
const openRow = (label: RegExp): void => {
  toHistory();
  fireEvent.click(screen.getByLabelText(label));
};

const type = (text: string): void => {
  fireEvent.change(screen.getByTestId('editor'), { target: { value: text } });
};

const sendMsg = (text: string): void => {
  fireEvent.change(screen.getByPlaceholderText(/plan, scope/i), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
};

const confirmCreate = async (): Promise<void> => {
  await screen.findByText(/create a task on github\?/i);
  const buttons = screen.getAllByRole('button', { name: /^create task$/i });
  fireEvent.click(buttons.at(-1)!);
};

/** apiComplete calls that are chat turns (the auto-title follow-up uses a different preset). */
const planCalls = (): unknown[][] =>
  vi.mocked(ipc.apiComplete).mock.calls.filter((c) => String((c[1] as { system?: string }).system).includes('<doc>'));

// ── lazy mint ──────────────────────────────────────────────────────────────────────────────────

test('opening the screen and clicking [+] N times writes ZERO files (the 29-notes fix)', async () => {
  renderFresh();
  const plus = await drawerReady();
  fireEvent.click(plus);
  fireEvent.click(plus);
  fireEvent.click(plus);
  await settle();
  expect(ipc.writeDraft).not.toHaveBeenCalled();
  expect(files.size).toBe(0);
});

test('the first keystroke mints exactly one draft file; further typing stays on the same id', async () => {
  renderFresh();
  await drawerReady();
  type('# F');
  type('# Fix');
  await settle();
  expect(files.size).toBe(1);
  const [id] = [...files.keys()];
  expect(id).toMatch(/^draft-/);
  expect((JSON.parse(files.get(id)!) as DraftData).body).toBe('# Fix');
});

test('typing then sending within the debounce window still yields ONE file (shared synchronous mint)', async () => {
  renderFresh();
  await drawerReady();
  type('some body'); // debounce armed, not yet fired
  sendMsg('plan it');
  await settle();
  expect(files.size).toBe(1);
  const data = JSON.parse([...files.values()].at(-1)!) as DraftData;
  expect(data.body).toBe('some body');
  expect(data.chat.map((m) => m.role)).toEqual(['user', 'assistant']);
});

test('chat turns persist immediately and the transcript keeps the RAW <doc> reply', async () => {
  vi.mocked(ipc.apiComplete).mockResolvedValueOnce({ text: 'here <doc># Revised</doc>' });
  renderFresh();
  await drawerReady();
  sendMsg('plan it');
  await waitFor(() => expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument());
  await settle();
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.chat.at(-1)?.content).toBe('here <doc># Revised</doc>'); // not the display placeholder
});

test('deleting a typed draft before the debounce fires leaves NO file behind (no resurrection)', async () => {
  renderFresh();
  await drawerReady();
  type('# Doomed');
  // The entry exists in History (mint is synchronous); delete it before the 800ms save fires.
  toHistory();
  fireEvent.click(screen.getByLabelText(/delete Doomed/i));
  fireEvent.click(screen.getByText('delete'));
  await settle();
  expect(files.size).toBe(0);
});

// ── resume / history / tabs ────────────────────────────────────────────────────────────────────

test('resume: a persisted draft opens from History with its transcript, and continues', async () => {
  seed('draft-old', {
    body: '# Old plan\n',
    chat: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ],
  });
  renderFresh();
  await drawerReady();
  openRow(/open Old plan/);
  expect(screen.getByTestId('editor')).toHaveValue('# Old plan\n');
  expect(screen.getByText('q1')).toBeInTheDocument();
  expect(screen.getByText('a1')).toBeInTheDocument();
  sendMsg('q2');
  await settle();
  const data = JSON.parse(files.get('draft-old')!) as DraftData;
  expect(data.chat.map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'ok']);
});

test('History opens tabs; tab clicks swap the editor; closing a tab keeps the file and the row', async () => {
  seed('draft-a', { body: '# Alpha\n' });
  seed('draft-b', { body: '# Beta\n' });
  renderFresh();
  await drawerReady();
  openRow(/open Alpha/);
  openRow(/open Beta/);
  expect(screen.getByTestId('editor')).toHaveValue('# Beta\n');
  expect(screen.getByLabelText('tab Alpha')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('tab Alpha'));
  expect(screen.getByTestId('editor')).toHaveValue('# Alpha\n');
  // Close Beta's tab: the strip loses it, the file and its History row survive.
  fireEvent.click(screen.getByLabelText('close Beta'));
  expect(screen.queryByLabelText('tab Beta')).toBeNull();
  expect(files.has('draft-b')).toBe(true);
  toHistory();
  expect(screen.getByLabelText('open Beta')).toBeInTheDocument();
});

test('closing the ACTIVE tab focuses the left neighbor and flushes the closing draft', async () => {
  seed('draft-a', { body: '# Alpha\n' });
  seed('draft-b', { body: '# Beta\n' });
  renderFresh();
  await drawerReady();
  openRow(/open Alpha/);
  openRow(/open Beta/);
  type('# Beta edited'); // debounce armed on Beta
  fireEvent.click(screen.getByLabelText('close Beta edited'));
  expect(screen.getByTestId('editor')).toHaveValue('# Alpha\n'); // left neighbor focused
  await settle();
  expect((JSON.parse(files.get('draft-b')!) as DraftData).body).toBe('# Beta edited'); // flushed, not lost
});

test('two tabs can have turns in flight at once; each reply lands in its own file', async () => {
  seed('draft-a', { body: '# Alpha\n', name: 'Alpha' });
  seed('draft-b', { body: '# Beta\n', name: 'Beta' });
  let resolveA: (v: { text?: string }) => void = () => {};
  let resolveB: (v: { text?: string }) => void = () => {};
  vi.mocked(ipc.apiComplete)
    .mockReturnValueOnce(new Promise((r) => (resolveA = r)))
    .mockReturnValueOnce(new Promise((r) => (resolveB = r)));
  renderFresh();
  await drawerReady();
  openRow(/open Alpha/);
  sendMsg('qa');
  openRow(/open Beta/);
  sendMsg('qb');
  await settle();
  resolveA({ text: 'ra' });
  resolveB({ text: 'rb' });
  await settle();
  expect((JSON.parse(files.get('draft-a')!) as DraftData).chat).toEqual([
    { role: 'user', content: 'qa' },
    { role: 'assistant', content: 'ra' },
  ]);
  expect((JSON.parse(files.get('draft-b')!) as DraftData).chat).toEqual([
    { role: 'user', content: 'qb' },
    { role: 'assistant', content: 'rb' },
  ]);
});

test('a reply landing on an unfocused tab shows the activity dot; focusing the tab clears it', async () => {
  seed('draft-a', { body: '# Alpha\n', name: 'Alpha' });
  seed('draft-b', { body: '# Beta\n', name: 'Beta' });
  let resolveA: (v: { text?: string }) => void = () => {};
  vi.mocked(ipc.apiComplete).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
  renderFresh();
  await drawerReady();
  openRow(/open Alpha/);
  sendMsg('qa');
  openRow(/open Beta/);
  resolveA({ text: 'ra' });
  await settle();
  expect(screen.getByLabelText('Alpha activity')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('tab Alpha'));
  await waitFor(() => expect(screen.queryByLabelText('Alpha activity')).toBeNull());
});

// ── create / archive ───────────────────────────────────────────────────────────────────────────

test('create task archives the draft ON DISK even when the user switches drafts mid-create (G1)', async () => {
  seed('draft-other', { body: '# Other\n' });
  let resolveCreate: (v: { id: string; url: string }) => void = () => {};
  vi.mocked(ipc.apiCreateTask).mockReturnValueOnce(new Promise((r) => (resolveCreate = r)));
  renderFresh();
  await drawerReady();
  type('# File me\n');
  await settle();
  const filedId = [...files.keys()].find((k) => k !== 'draft-other')!;
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  // Switch away while the create is in flight.
  openRow(/open Other/);
  resolveCreate({ id: 'gh-9', url: 'https://github.com/o/r/issues/9' });
  await settle();
  const filed = JSON.parse(files.get(filedId)!) as DraftData;
  expect(filed.archived).toBe(true); // the id-keyed write landed despite the switch
  expect(filed.created).toEqual({ id: 'gh-9', url: 'https://github.com/o/r/issues/9' });
});

test('after filing, a stale debounced save cannot un-archive the draft (G14)', async () => {
  renderFresh();
  await drawerReady();
  type('# Ship it\n');
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  await waitFor(() => expect(screen.getByText(/filed as/i)).toBeInTheDocument());
  await settle(); // anything still armed fires now
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.archived).toBe(true);
  expect(data.created?.id).toBe('gh-7');
});

test('archived drafts are read-only: chat disabled, header shows chip + Open board + Duplicate', async () => {
  seed('draft-done', { body: '# Done thing\n', archived: true, created: { id: 'gh-3', url: 'https://g/3' } });
  renderFresh();
  await drawerReady();
  openRow(/open Done thing/);
  expect(screen.getByTestId('editor')).toHaveAttribute('data-readonly', 'true');
  expect(screen.getByPlaceholderText(/read-only/i)).toBeDisabled();
  expect(screen.queryByRole('button', { name: /create task/i })).toBeNull();
  expect(screen.getByRole('link', { name: /filed as #gh-3/i })).toHaveAttribute('href', 'https://g/3');
  // Duplicate yields a fresh, filable copy with no `created`.
  fireEvent.click(screen.getByRole('button', { name: /duplicate/i }));
  await settle();
  const copyId = [...files.keys()].find((k) => k !== 'draft-done')!;
  const copy = JSON.parse(files.get(copyId)!) as DraftData;
  expect(copy.body).toBe('# Done thing\n');
  expect(copy.archived).toBe(false);
  expect(copy.created).toBeUndefined();
  expect(screen.getByRole('button', { name: /create task/i })).toBeInTheDocument();
});

test('an unreadable draft file is listed delete-only — never openable, never hidden (AC6)', async () => {
  files.set('My Draft', '{corrupt');
  renderFresh();
  await drawerReady();
  toHistory();
  type('# typed first'); // the active fresh draft — an unreadable row must not steal focus
  fireEvent.click(screen.getByLabelText(/open My Draft \(unreadable\)/));
  expect(screen.getByTestId('editor')).toHaveValue('# typed first'); // click was a no-op
  expect(screen.queryByLabelText(/tab My Draft/)).toBeNull();
  fireEvent.click(screen.getByLabelText(/delete My Draft/i));
  fireEvent.click(screen.getByText('delete'));
  await settle();
  expect(files.has('My Draft')).toBe(false);
  expect(screen.queryByLabelText(/open My Draft/)).toBeNull();
});

// ── nonce / session memory ─────────────────────────────────────────────────────────────────────

test('a New Task click (nonce bump) resets to a fresh conversation; the old one stays in History', async () => {
  const project = freshProject();
  const view = render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await drawerReady();
  type('# Keep me\n');
  await settle();
  view.rerender(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  expect(screen.getByTestId('editor')).toHaveValue('');
  toHistory();
  expect(screen.getByLabelText(/open Keep me/)).toBeInTheDocument();
  expect(files.size).toBe(1); // reset did not mint anything
});

test('re-entering WITHOUT a New Task click restores the open tabs and active draft (session memory)', async () => {
  seed('draft-a', { body: '# Alpha\n' });
  const project = freshProject();
  const first = render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await drawerReady();
  openRow(/open Alpha/);
  type('# Alpha resumed\n');
  await settle();
  first.unmount();
  // Same nonce (already consumed) — e.g. coming back from a Settings detour.
  render(<TaskDraftScreen project={project} freshNonce={nonce} onOpenBoard={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('editor')).toHaveValue('# Alpha resumed\n'));
  expect(await screen.findByLabelText(/tab Alpha resumed/)).toBeInTheDocument(); // tab restored too
});

test('New Task on a REMOUNT lands on a fresh draft even with a remembered selection (review #349 r4 high)', async () => {
  const project = freshProject();
  const first = render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await drawerReady();
  type('# Remembered\n');
  await settle(); // persists AND records the session
  first.unmount();
  // Board → New Task: fresh mount with a NEW nonce. The async entry-loader must not restore the
  // remembered draft over the fresh one the nonce demands.
  render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await screen.findByLabelText(/tab Remembered/); // loader done (remembered tab restored to strip)
  await settle();
  expect(screen.getByTestId('editor')).toHaveValue('');
});

test('typing before the mount loader resolves is not clobbered by it (review #349 r7)', async () => {
  seed('draft-b', { body: '# Existing\n' });
  let resolveList: (v: string[]) => void = () => {};
  vi.mocked(ipc.listDrafts).mockReturnValueOnce(new Promise((r) => (resolveList = r)));
  renderFresh();
  // The editor is live before the drafts load — start typing immediately.
  type('# Early bird');
  resolveList(['draft-b']);
  await settle();
  expect(screen.getByTestId('editor')).toHaveValue('# Early bird'); // not yanked away
  toHistory();
  expect(screen.getByLabelText(/open Early bird/)).toBeInTheDocument();
  expect(screen.getByLabelText(/open Existing/)).toBeInTheDocument(); // disk entries merged in
});

// ── review-hardened S10 guards, carried over ───────────────────────────────────────────────────

test('a completion outstanding for a draft blocks a second send after switching away and back (review #349 r1)', async () => {
  seed('draft-b', { body: '# B\n' });
  let resolveA: (v: { text?: string }) => void = () => {};
  vi.mocked(ipc.apiComplete).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
  renderFresh();
  await drawerReady();
  sendMsg('q');
  await settle();
  const draftAId = [...files.keys()].find((k) => k !== 'draft-b')!;
  // Leave and come back while A's completion is still in flight.
  openRow(/open B/);
  openRow(/open q/);
  // The reloaded draft must present as busy — and a second send must NOT fire a second completion.
  sendMsg('q again');
  await settle();
  expect(planCalls().length).toBe(1);
  resolveA({ text: 'answer' });
  await settle();
  const data = JSON.parse(files.get(draftAId)!) as DraftData;
  expect(data.chat).toEqual([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'answer' }, // exactly one reply — no duplicate persisted turn
  ]);
});

test('switching drafts INSIDE the debounce window persists the outgoing draft, not the incoming one (review #349 r2 blocking)', async () => {
  seed('draft-b', { body: '# B stays\n', archived: true, created: { id: 'gh-2', url: 'https://g/2' } });
  renderFresh();
  await drawerReady();
  type('# A body');
  // No settle: the 800ms debounce is still armed when the switch happens.
  openRow(/open B stays/);
  await settle();
  const aId = [...files.keys()].find((k) => k !== 'draft-b')!;
  const a = JSON.parse(files.get(aId)!) as DraftData;
  expect(a.body).toBe('# A body'); // NOT wiped, NOT B's body
  expect(a.archived).toBe(false); // and NOT mis-archived with B's created link
  expect(a.created).toBeUndefined();
  expect((JSON.parse(files.get('draft-b')!) as DraftData).body).toBe('# B stays\n');
});

test('New Task inside the debounce window does not wipe the outgoing draft (review #349 r2 blocking)', async () => {
  const project = freshProject();
  const view = render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await drawerReady();
  type('# Keep this body');
  view.rerender(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await settle();
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.body).toBe('# Keep this body'); // not overwritten with emptyDraft()
});

test('the editor is read-only while a create is confirming/in flight — a keystroke cannot arm an un-archiving debounce (review #349 r4)', async () => {
  let resolveCreate: (v: { id: string; url: string }) => void = () => {};
  vi.mocked(ipc.apiCreateTask).mockReturnValueOnce(new Promise((r) => (resolveCreate = r)));
  renderFresh();
  await drawerReady();
  type('# Lock me\n');
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await screen.findByText(/create a task on github\?/i);
  expect(screen.getByTestId('editor')).toHaveAttribute('data-readonly', 'true'); // dialog open
  const buttons = screen.getAllByRole('button', { name: /^create task$/i });
  fireEvent.click(buttons.at(-1)!);
  expect(screen.getByTestId('editor')).toHaveAttribute('data-readonly', 'true'); // create in flight
  resolveCreate({ id: 'gh-7', url: 'https://g/7' });
  await settle();
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.archived).toBe(true);
});

test('the outbound completion carries the body of the draft it was issued FOR, not the draft now open (review #349 r5 blocking)', async () => {
  seed('draft-b', { body: '# Secret B contents\n' });
  vi.mocked(ipc.readAppConfig).mockResolvedValueOnce({ source: 'github' }); // the mount read
  let resolveCfg: (v: { chatModel?: string }) => void = () => {};
  vi.mocked(ipc.readAppConfig).mockReturnValueOnce(new Promise((r) => (resolveCfg = r))); // the send-path read
  renderFresh();
  await drawerReady();
  type('# A private body\n');
  sendMsg('plan it');
  // Switch to B while the send path is still awaiting readAppConfig.
  openRow(/open Secret B contents/);
  resolveCfg({});
  await settle();
  expect(planCalls().length).toBe(1);
  const system = (planCalls()[0][1] as { system: string }).system;
  expect(system).toContain('# A private body'); // the draft the turn was issued for
  expect(system).not.toContain('Secret B contents'); // never the draft the user switched to
});

test('a transient failure of the archive write shows the do-not-re-file warning (review #349 r7)', async () => {
  renderFresh();
  await drawerReady();
  type('# Fragile\n');
  await settle();
  // The archive step is a read-modify-write; fail its read once (transient IO — NOT a delete).
  vi.mocked(ipc.readDraft).mockRejectedValueOnce(new Error('EIO'));
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  await settle();
  // The issue exists but the file was never archived — the user MUST be warned off re-filing.
  expect(screen.getByText(/do not re-file/i)).toBeInTheDocument();
});

test('a draft deliberately deleted mid-create does NOT get the scary warning (review #349 r4/r7)', async () => {
  let resolveCreate: (v: { id: string; url: string }) => void = () => {};
  vi.mocked(ipc.apiCreateTask).mockReturnValueOnce(new Promise((r) => (resolveCreate = r)));
  renderFresh();
  await drawerReady();
  type('# Doomed but filed\n');
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  // Delete the draft while the create is in flight.
  toHistory();
  fireEvent.click(screen.getByLabelText(/delete Doomed but filed/i));
  fireEvent.click(screen.getByText('delete'));
  resolveCreate({ id: 'gh-7', url: 'https://g/7' });
  await settle();
  expect(files.size).toBe(0); // update skipped — no resurrection
  expect(screen.queryByText(/do not re-file/i)).toBeNull();
});

test('Open board is offered after filing and navigates', async () => {
  const onOpenBoard = vi.fn();
  render(<TaskDraftScreen project={freshProject()} freshNonce={++nonce} onOpenBoard={onOpenBoard} />);
  await drawerReady();
  type('# Go\n');
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  fireEvent.click(await screen.findByRole('button', { name: /open board/i }));
  expect(onOpenBoard).toHaveBeenCalled();
});

// ── naming (handoff §3) ────────────────────────────────────────────────────────────────────────

test('double-click renames a tab inline; the name persists and beats the derived label', async () => {
  seed('draft-a', { body: '# Alpha\n' });
  renderFresh();
  await drawerReady();
  openRow(/open Alpha/);
  fireEvent.doubleClick(screen.getByLabelText('tab Alpha'));
  const input = screen.getByLabelText(/rename Alpha/);
  fireEvent.change(input, { target: { value: 'My spike' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await settle();
  expect((JSON.parse(files.get('draft-a')!) as DraftData).name).toBe('My spike');
  expect(screen.getByLabelText('tab My spike')).toBeInTheDocument();
  // Empty rename clears the override — back to the heading.
  fireEvent.doubleClick(screen.getByLabelText('tab My spike'));
  const again = screen.getByLabelText(/rename My spike/);
  fireEvent.change(again, { target: { value: '  ' } });
  fireEvent.keyDown(again, { key: 'Enter' });
  await settle();
  expect((JSON.parse(files.get('draft-a')!) as DraftData).name).toBeUndefined();
  expect(screen.getByLabelText('tab Alpha')).toBeInTheDocument();
});

test('the first exchange auto-titles an unnamed conversation (LLM rename)', async () => {
  vi.mocked(ipc.apiComplete)
    .mockResolvedValueOnce({ text: 'the reply' })
    .mockResolvedValueOnce({ text: '  "Settings Flicker Fix."  ' });
  renderFresh();
  await drawerReady();
  sendMsg('theme toggling flashes the sidebar');
  await settle();
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.name).toBe('Settings Flicker Fix'); // trimmed, unquoted, no trailing period
  expect(screen.getByLabelText('tab Settings Flicker Fix')).toBeInTheDocument();
  // Second exchange must NOT re-title.
  sendMsg('more');
  await settle();
  expect(
    vi.mocked(ipc.apiComplete).mock.calls.filter((c) => String((c[1] as { system?: string }).system).includes('short title'))
      .length,
  ).toBe(1);
});

test('a user rename racing the auto-title WINS (id-keyed re-check)', async () => {
  let resolveTitle: (v: { text?: string }) => void = () => {};
  vi.mocked(ipc.apiComplete)
    .mockResolvedValueOnce({ text: 'the reply' })
    .mockReturnValueOnce(new Promise((r) => (resolveTitle = r)));
  renderFresh();
  await drawerReady();
  sendMsg('name race');
  await settle(); // reply landed; the title completion is still in flight
  fireEvent.doubleClick(screen.getByLabelText('tab name race'));
  const input = screen.getByLabelText(/rename/);
  fireEvent.change(input, { target: { value: 'User choice' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await settle();
  resolveTitle({ text: 'Robot Title' });
  await settle();
  expect((JSON.parse([...files.values()][0]!) as DraftData).name).toBe('User choice');
  expect(screen.getByLabelText('tab User choice')).toBeInTheDocument();
});

// ── model selection (handoff §4) ───────────────────────────────────────────────────────────────

test('model options come from the vanguard config; a choice persists per draft and is sent', async () => {
  vi.mocked(ipc.readAppConfig).mockResolvedValue({
    source: 'github',
    chatModel: 'claude-sonnet-5',
    customProviders: [
      { name: 'z', baseUrl: 'https://z', keyEnv: 'Z_KEY', model: 'glm-5.2' },
      { name: 'z2', baseUrl: 'https://z2', keyEnv: 'Z_KEY', model: 'glm-5.2' }, // dupe — collapses
    ],
  });
  renderFresh();
  await drawerReady();
  const select = await screen.findByLabelText('chat model');
  expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'glm-5.2']);
  fireEvent.change(select, { target: { value: 'glm-5.2' } });
  sendMsg('go');
  await settle();
  expect((planCalls()[0][1] as { model: string }).model).toBe('glm-5.2');
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.chatModel).toBe('glm-5.2');
});

test('the model is snapshotted at send — a draft switch mid-flight cannot swap it (review #349 r5 discipline)', async () => {
  seed('draft-b', { body: '# B\n', chatModel: 'other-model' });
  vi.mocked(ipc.readAppConfig).mockResolvedValueOnce({ source: 'github' }); // mount
  let resolveCfg: (v: Record<string, never>) => void = () => {};
  vi.mocked(ipc.readAppConfig).mockReturnValueOnce(new Promise((r) => (resolveCfg = r))); // send-path
  renderFresh();
  await drawerReady();
  sendMsg('question'); // fresh draft, default model
  openRow(/open B/); // switch while the send awaits config; B carries an override
  resolveCfg({});
  await settle();
  expect((planCalls()[0][1] as { model: string }).model).toBe('claude-sonnet-5'); // not B's override
});

test('a fresh conversation is NOT minted by a model choice alone (lazy mint holds)', async () => {
  renderFresh();
  await drawerReady();
  fireEvent.change(screen.getByLabelText('chat model'), { target: { value: '' } });
  await settle();
  expect(files.size).toBe(0);
});
