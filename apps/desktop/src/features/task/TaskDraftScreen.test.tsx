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

// The screen keeps session memory (last selection / consumed nonce) at module level; isolate
// tests with a unique project per test and a strictly increasing nonce.
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

const renderFresh = (project = freshProject()): ReturnType<typeof render> =>
  render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);

const type = (text: string): void => {
  fireEvent.change(screen.getByTestId('editor'), { target: { value: text } });
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

test('opening the screen and clicking New draft N times writes ZERO files (the 29-notes fix)', async () => {
  renderFresh();
  const newDraft = await screen.findByRole('button', { name: /new draft/i });
  fireEvent.click(newDraft);
  fireEvent.click(newDraft);
  fireEvent.click(newDraft);
  await settle();
  expect(ipc.writeDraft).not.toHaveBeenCalled();
  expect(files.size).toBe(0);
});

test('the first keystroke mints exactly one draft file; further typing stays on the same id', async () => {
  renderFresh();
  await screen.findByRole('button', { name: /new draft/i });
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
  await screen.findByRole('button', { name: /new draft/i });
  type('some body'); // debounce armed, not yet fired
  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'plan it' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await settle();
  expect(files.size).toBe(1);
  const data = JSON.parse([...files.values()].at(-1)!) as DraftData;
  expect(data.body).toBe('some body');
  expect(data.chat.map((m) => m.role)).toEqual(['user', 'assistant']);
});

test('chat turns persist immediately and the transcript keeps the RAW <doc> reply', async () => {
  vi.mocked(ipc.apiComplete).mockResolvedValueOnce({ text: 'here <doc># Revised</doc>' });
  renderFresh();
  await screen.findByRole('button', { name: /new draft/i });
  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'plan it' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument());
  await settle();
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.chat.at(-1)?.content).toBe('here <doc># Revised</doc>'); // not the display placeholder
});

test('deleting a typed draft before the debounce fires leaves NO file behind (no resurrection)', async () => {
  renderFresh();
  await screen.findByRole('button', { name: /new draft/i });
  type('# Doomed');
  // The entry exists in the sidebar (mint is synchronous); delete it before the 800ms save fires.
  fireEvent.click(screen.getByLabelText(/delete Doomed/i));
  fireEvent.click(screen.getByText('delete'));
  await settle();
  expect(files.size).toBe(0);
});

test('resume: a persisted draft lists by title, opens with its transcript, and continues', async () => {
  seed('draft-old', {
    body: '# Old plan\n',
    chat: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ],
  });
  const project = freshProject();
  render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  fireEvent.click(await screen.findByText('Old plan'));
  expect(screen.getByTestId('editor')).toHaveValue('# Old plan\n');
  expect(screen.getByText('q1')).toBeInTheDocument();
  expect(screen.getByText('a1')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'q2' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await settle();
  const data = JSON.parse(files.get('draft-old')!) as DraftData;
  expect(data.chat.map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'ok']);
});

test('create task archives the draft ON DISK even when the user switches drafts mid-create (G1)', async () => {
  seed('draft-other', { body: '# Other\n' });
  let resolveCreate: (v: { id: string; url: string }) => void = () => {};
  vi.mocked(ipc.apiCreateTask).mockReturnValueOnce(new Promise((r) => (resolveCreate = r)));
  renderFresh();
  await screen.findByText('Other');
  type('# File me\n');
  await settle();
  const filedId = [...files.keys()].find((k) => k !== 'draft-other')!;
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  // Switch away while the create is in flight.
  fireEvent.click(screen.getByText('Other'));
  resolveCreate({ id: 'gh-9', url: 'https://github.com/o/r/issues/9' });
  await settle();
  const filed = JSON.parse(files.get(filedId)!) as DraftData;
  expect(filed.archived).toBe(true); // the id-keyed write landed despite the switch
  expect(filed.created).toEqual({ id: 'gh-9', url: 'https://github.com/o/r/issues/9' });
});

test('after filing, a stale debounced save cannot un-archive the draft (G14)', async () => {
  renderFresh();
  await screen.findByRole('button', { name: /new draft/i });
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

test('archived drafts are read-only: chat disabled, no Create button, link chip + Duplicate instead', async () => {
  seed('draft-done', { body: '# Done thing\n', archived: true, created: { id: 'gh-3', url: 'https://g/3' } });
  renderFresh();
  fireEvent.click(await screen.findByText('Done thing'));
  expect(screen.getByTestId('editor')).toHaveAttribute('data-readonly', 'true');
  expect(screen.getByPlaceholderText(/read-only/i)).toBeDisabled();
  expect(screen.queryByRole('button', { name: /create task/i })).toBeNull();
  expect(screen.getByRole('link', { name: 'gh-3' })).toHaveAttribute('href', 'https://g/3');
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

test('an unreadable draft file is listed and deletable — never hidden (AC6)', async () => {
  files.set('My Draft', '{corrupt');
  renderFresh();
  fireEvent.click(await screen.findByText(/My Draft \(unreadable\)/));
  expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/delete My Draft/i));
  fireEvent.click(screen.getByText('delete'));
  await settle();
  expect(files.size).toBe(0);
  expect(screen.queryByText(/My Draft/)).toBeNull();
});

test('a New Task click (nonce bump) resets to a fresh draft; the old one stays in the sidebar', async () => {
  const project = freshProject();
  const view = render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await screen.findByRole('button', { name: /new draft/i });
  type('# Keep me\n');
  await settle();
  view.rerender(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  expect(screen.getByTestId('editor')).toHaveValue('');
  expect(screen.getByText('Keep me')).toBeInTheDocument();
  expect(files.size).toBe(1); // reset did not mint anything
});

test('re-entering WITHOUT a New Task click restores the last-open draft (session memory)', async () => {
  const project = freshProject();
  const first = render(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await screen.findByRole('button', { name: /new draft/i });
  type('# Resume me\n');
  await settle();
  first.unmount();
  // Same nonce (already consumed) — e.g. coming back from a Settings detour.
  render(<TaskDraftScreen project={project} freshNonce={nonce} onOpenBoard={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('editor')).toHaveValue('# Resume me\n'));
});

test('a completion outstanding for a draft blocks a second send after switching away and back (review #349 r1)', async () => {
  seed('draft-b', { body: '# B\n' });
  let resolveA: (v: { text?: string }) => void = () => {};
  vi.mocked(ipc.apiComplete).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
  renderFresh();
  await screen.findByText('B');
  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'q' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await settle();
  const draftAId = [...files.keys()].find((k) => k !== 'draft-b')!;
  // Leave and come back while A's completion is still in flight.
  fireEvent.click(screen.getByText('B'));
  fireEvent.click(screen.getByText('q'));
  // The reloaded draft must present as busy — and a second send must NOT fire a second completion.
  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'q again' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await settle();
  expect(ipc.apiComplete).toHaveBeenCalledTimes(1);
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
  await screen.findByText('B stays');
  type('# A body');
  // No settle: the 800ms debounce is still armed when the switch happens.
  fireEvent.click(screen.getByText('B stays'));
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
  await screen.findByRole('button', { name: /new draft/i });
  type('# Keep this body');
  view.rerender(<TaskDraftScreen project={project} freshNonce={++nonce} onOpenBoard={() => {}} />);
  await settle();
  const data = JSON.parse([...files.values()][0]!) as DraftData;
  expect(data.body).toBe('# Keep this body'); // not overwritten with emptyDraft()
});

test('Open board is offered after filing and navigates', async () => {
  const onOpenBoard = vi.fn();
  render(<TaskDraftScreen project={freshProject()} freshNonce={++nonce} onOpenBoard={onOpenBoard} />);
  await screen.findByRole('button', { name: /new draft/i });
  type('# Go\n');
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /create task/i }));
  await confirmCreate();
  fireEvent.click(await screen.findByRole('button', { name: /open board/i }));
  expect(onOpenBoard).toHaveBeenCalled();
});
