import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocsScreen } from './DocsScreen.js';
import * as ipc from '../../ipc.js';

vi.mock('../../ipc.js', () => ({
  listDocs: vi.fn(async () => ['plan.md']),
  readDoc: vi.fn(async () => '# Plan\n'),
  writeDoc: vi.fn(async () => {}),
  readAppConfig: vi.fn(async () => ({})),
  apiComplete: vi.fn(async () => ({ text: 'done <doc>REVISED</doc>' })),
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

test('New doc creates and opens a note', async () => {
  render(<DocsScreen project="/repo" />);
  await screen.findByText('plan.md');
  fireEvent.click(screen.getByRole('button', { name: /new doc/i }));
  await waitFor(() => expect(ipc.writeDoc).toHaveBeenCalledWith('/repo', 'note-2.md', expect.stringContaining('# note-2')));
});
