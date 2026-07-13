import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocsScreen } from './DocsScreen.js';
import { MAX_BODY_BYTES } from './docTask.js';
import * as ipc from '../../ipc.js';

vi.mock('../../ipc.js', () => ({
  listDocs: vi.fn(async () => ['plan.md']),
  readDoc: vi.fn(async () => '# Plan\n'),
  writeDoc: vi.fn(async () => {}),
  readAppConfig: vi.fn(async () => ({})),
  apiComplete: vi.fn(async () => ({ text: 'done <doc>REVISED</doc>' })),
  apiCreateTask: vi.fn(async () => ({ id: 'o/r#7', url: 'https://github.com/o/r/issues/7' })),
}));

// Replace the real CodeMirror editor with a plain div — CM6 needs DOM geometry jsdom lacks, and its
// own render is covered by DocEditor.test. This lets us assert the doc value + read-only state.
vi.mock('./DocEditor.js', () => ({
  DocEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) => (
    <div data-testid="editor" data-readonly={String(readOnly === true)}>
      {value}
    </div>
  ),
}));

beforeEach(() => vi.clearAllMocks());

test('lists docs from the repo', async () => {
  render(<DocsScreen project="/repo" />);
  expect(await screen.findByText('plan.md')).toBeInTheDocument();
});

test('opening a doc reads it and shows its content', async () => {
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'plan.md'));
  expect(screen.getByTestId('editor')).toHaveTextContent('# Plan');
});

test('a <doc> reply proposes an edit; accept applies it, writes it, and re-enables editing', async () => {
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());

  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'make a plan' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));

  const acceptBtn = await screen.findByRole('button', { name: /accept/i });
  // While pending, the editor is read-only (no silent edit loss).
  expect(screen.getByTestId('editor')).toHaveAttribute('data-readonly', 'true');

  fireEvent.click(acceptBtn);
  await waitFor(() => expect(ipc.writeDoc).toHaveBeenCalledWith('/repo', 'plan.md', 'REVISED'));
  expect(screen.getByTestId('editor')).toHaveTextContent('REVISED');
  expect(screen.getByTestId('editor')).toHaveAttribute('data-readonly', 'false');
});

test('an in-flight completion that resolves AFTER a doc switch is dropped (no cross-doc bar)', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['a.md', 'b.md']);
  let resolveA: (v: { text?: string }) => void = () => {};
  vi.mocked(ipc.apiComplete).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('a.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'a.md'));

  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'plan a' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i })); // in flight, unresolved

  fireEvent.click(screen.getByText('b.md')); // switch before the reply lands
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'b.md'));

  resolveA({ text: 'done <doc>REVISED-A</doc>' }); // a.md's reply resolves now
  await Promise.resolve();
  // The stale reply must NOT surface a proposal on b.md.
  expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
});

test('a double-click on Send fires only one completion', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['a.md']);
  vi.mocked(ipc.apiComplete).mockReturnValueOnce(new Promise(() => {})); // never settles — stays in flight
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('a.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'a.md'));

  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'plan a' } });
  const send = screen.getByRole('button', { name: /send/i });
  // Both clicks land in the same tick, before `chat.busy` (and the disabled prop) can re-render.
  fireEvent.click(send);
  fireEvent.click(send);

  // apiComplete is reached through an awaited readAppConfig, so let the microtasks drain first.
  await waitFor(() => expect(ipc.apiComplete).toHaveBeenCalled());
  expect(ipc.apiComplete).toHaveBeenCalledTimes(1);
});

test('a stale readDoc landing after a fast doc switch does not show the wrong doc', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['a.md', 'b.md']);
  let resolveA: (v: string) => void = () => {};
  vi.mocked(ipc.readDoc)
    .mockReturnValueOnce(new Promise((r) => (resolveA = r))) // a.md — hangs
    .mockResolvedValueOnce('# B'); // b.md — lands first
  render(<DocsScreen project="/repo" />);

  fireEvent.click(await screen.findByText('a.md'));
  fireEvent.click(screen.getByText('b.md')); // switch before a.md's read resolves
  await waitFor(() => expect(screen.getByTestId('editor')).toHaveTextContent('# B'));

  resolveA('# A'); // a.md's read finally lands — it must not overwrite the doc the user clicked
  await Promise.resolve();
  expect(screen.getByTestId('editor')).toHaveTextContent('# B');
});

test('re-clicking the already-open doc does not reset the chat', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['a.md']);
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('a.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('a.md')); // re-click the active doc
  await Promise.resolve();
  expect(ipc.readDoc).toHaveBeenCalledTimes(1); // no re-read, no reset
});

test('switching docs clears a pending proposal (no cross-doc write on accept)', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['a.md', 'b.md']);
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('a.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'a.md'));

  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: 'plan a' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await screen.findByRole('button', { name: /accept/i }); // proposal pending for a.md

  fireEvent.click(screen.getByText('b.md')); // switch docs
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'b.md'));
  // The accept bar is gone — no way to write a.md's proposal into b.md.
  expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
});

test('New doc creates the first free note-N (no collision on a numbering gap)', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['note-1.md', 'note-3.md']);
  render(<DocsScreen project="/repo" />);
  await screen.findByText('note-1.md');
  fireEvent.click(screen.getByRole('button', { name: /new doc/i }));
  // note-1 exists → skip; note-2 is free → use it (must NOT reuse note-1 or clobber note-3).
  await waitFor(() => expect(ipc.writeDoc).toHaveBeenCalledWith('/repo', 'note-2.md', expect.stringContaining('# note-2')));
});

test('Create task never fires without an explicit confirmation', async () => {
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());

  // Clicking the button opens the dialog. It must NOT create anything yet — this write cannot be undone.
  fireEvent.click(screen.getByRole('button', { name: /^create task$/i }));
  expect(ipc.apiCreateTask).not.toHaveBeenCalled();
  expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

  // Cancelling must also create nothing.
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  expect(ipc.apiCreateTask).not.toHaveBeenCalled();
});

test('a double-click on the confirm button creates only ONE issue', async () => {
  vi.mocked(ipc.apiCreateTask).mockReturnValueOnce(new Promise(() => {})); // never settles: stays in flight
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('button', { name: /^create task$/i })); // open dialog
  const confirm = screen.getAllByRole('button', { name: /^create task$/i }).at(-1)!;
  // Both clicks land in one tick, before `creating` can re-render the button as disabled. Without the
  // ref guard this creates TWO REAL ISSUES, and neither can be deleted from the app.
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  await waitFor(() => expect(ipc.apiCreateTask).toHaveBeenCalled());
  expect(ipc.apiCreateTask).toHaveBeenCalledTimes(1);
});

test('a doc with no # heading cannot be turned into a task', async () => {
  vi.mocked(ipc.readDoc).mockResolvedValueOnce('no heading here, just prose');
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());
  // Refuse rather than invent: a filename fallback would create a real issue called `note-3.md`.
  expect(screen.getByRole('button', { name: /^create task$/i })).toBeDisabled();
  expect(screen.getByText(/add a .*heading/i)).toBeInTheDocument();
});

test('a failed create closes the dialog and shows the ambiguity warning where it can be READ', async () => {
  vi.mocked(ipc.apiCreateTask).mockRejectedValueOnce(new Error('network down'));
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('button', { name: /^create task$/i }));
  fireEvent.click(screen.getAllByRole('button', { name: /^create task$/i }).at(-1)!);

  // A failed WRITE is an ambiguous write: it may have landed before the error reached us.
  expect(await screen.findByText(/may or may not have been created/i)).toBeInTheDocument();

  // The dialog MUST be gone. Leaving it open puts a live confirm button back under the cursor with the
  // warning rendered behind the modal — one more click files the same issue twice. Asserting the text
  // exists is not enough: it existed before this fix too, just underneath the modal.
  await waitFor(() => expect(screen.queryByText(/cannot be undone/i)).toBeNull());
  expect(screen.getAllByRole('button', { name: /^create task$/i })).toHaveLength(1); // only the panel one
});

test('an over-long doc is refused BEFORE the irreversible click', async () => {
  vi.mocked(ipc.readDoc).mockResolvedValueOnce(`# Big\n\n${'x'.repeat(MAX_BODY_BYTES)}`);
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());

  expect(screen.getByRole('button', { name: /^create task$/i })).toBeDisabled();
  expect(screen.getByText(/too long to file/i)).toBeInTheDocument();
});

test('a create that lands AFTER a doc switch does not report itself under the new doc', async () => {
  vi.mocked(ipc.listDocs).mockResolvedValueOnce(['a.md', 'b.md']);
  let resolveCreate: (v: { id: string; url: string }) => void = () => {};
  vi.mocked(ipc.apiCreateTask).mockReturnValueOnce(new Promise((r) => (resolveCreate = r)));
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('a.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'a.md'));

  fireEvent.click(screen.getByRole('button', { name: /^create task$/i })); // open dialog
  fireEvent.click(screen.getAllByRole('button', { name: /^create task$/i }).at(-1)!); // confirm
  await waitFor(() => expect(ipc.apiCreateTask).toHaveBeenCalled());

  fireEvent.click(screen.getByText('b.md')); // switch docs while the create is in flight
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalledWith('/repo', 'b.md'));

  resolveCreate({ id: 'a-doc#1', url: 'https://example/issues/1' }); // a.md's create lands now
  await waitFor(() => expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull());

  // "Created <link>" under b.md would say b.md produced an issue it did not — misreporting the one
  // action the app cannot undo.
  expect(screen.queryByText('a-doc#1')).toBeNull();
  // ...and b.md's Create button must still work (the slot was released on switch).
  expect(screen.getByRole('button', { name: /^create task$/i })).toBeEnabled();
});


test('an unreadable app.json blocks Create task instead of guessing "github"', async () => {
  // Rust picks the real target from app.json independently. A renderer fallback would let the dialog
  // promise "github" while the issue is filed on Linear — a false promise about the one action with no undo.
  vi.mocked(ipc.readAppConfig).mockRejectedValueOnce(new Error('unreadable'));
  render(<DocsScreen project="/repo" />);
  fireEvent.click(await screen.findByText('plan.md'));
  await waitFor(() => expect(ipc.readDoc).toHaveBeenCalled());

  await waitFor(() => expect(screen.getByRole('button', { name: /^create task$/i })).toBeDisabled());
  expect(screen.getByText(/can't read the task source/i)).toBeInTheDocument();
  expect(ipc.apiCreateTask).not.toHaveBeenCalled();
});
