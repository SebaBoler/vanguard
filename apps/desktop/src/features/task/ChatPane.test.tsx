import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { ChatPane } from './ChatPane.js';
import type { DocChatState } from './useDocChat.js';

// The composer is a CodeMirror 6 instance (Editor UX 6/7). CM drives input through a contenteditable
// that jsdom can't type into, but its keymap runs off ordinary keydown events on `.cm-content`, so we
// exercise the send/recall/shortcut keys by dispatching keydown there and reach the underlying
// EditorView (for selection setup) via findFromDOM.
function composerContent(): HTMLElement {
  return document.querySelector('[data-testid="chat-composer"] .cm-content') as HTMLElement;
}
function composerView(): EditorView {
  const dom = document.querySelector('[data-testid="chat-composer"] .cm-editor') as HTMLElement;
  return EditorView.findFromDOM(dom)!;
}

const base: DocChatState = { messages: [{ role: 'user', content: 'plan this' }], busy: false };

const paneProps = {
  model: undefined as string | undefined,
  modelOptions: [] as string[],
  defaultModel: 'claude-sonnet-5',
  composerText: '',
  onModelChange: () => {},
  onComposerChange: () => {},
  onSend: () => {},
  onStop: () => {},
  onEditLast: () => {},
  onAccept: () => {},
  onReject: () => {},
};

test('renders the transcript', () => {
  render(<ChatPane state={base} {...paneProps} />);
  expect(screen.getByText('plan this')).toBeInTheDocument();
});

test('a persisted transcript cannot smuggle an unsafe link scheme through Markdown (review #349 r2)', () => {
  // Drafts can arrive committed inside a cloned repo; the transcript renders through the shared
  // Markdown component, whose react-markdown defaultUrlTransform must keep stripping javascript:.
  const hostile: DocChatState = {
    messages: [{ role: 'assistant', content: '[click me](javascript:alert(1)) and [ok](https://example.com)' }],
    busy: false,
  };
  render(<ChatPane state={hostile} {...paneProps} />);
  const links = screen.getAllByRole('link');
  for (const a of links) {
    expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  }
  expect(links.some((a) => a.getAttribute('href') === 'https://example.com')).toBe(true);
});

test('no accept/reject bar without a pending proposal', () => {
  render(<ChatPane state={base} {...paneProps} />);
  expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
});

test('accept/reject bar shows with a pending proposal and fires the callbacks', () => {
  const onAccept = vi.fn();
  const onReject = vi.fn();
  render(<ChatPane state={{ ...base, pending: 'NEW DOC' }} {...paneProps} onAccept={onAccept} onReject={onReject} />);
  fireEvent.click(screen.getByRole('button', { name: /accept/i }));
  fireEvent.click(screen.getByRole('button', { name: /reject/i }));
  expect(onAccept).toHaveBeenCalledOnce();
  expect(onReject).toHaveBeenCalledOnce();
});

test('send fires onSend with the trimmed draft', () => {
  const onSend = vi.fn();
  // The composer is controlled, so the unsent text arrives through the prop; send() trims it.
  render(<ChatPane state={base} {...paneProps} composerText="  hello  " onSend={onSend} />);
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  expect(onSend).toHaveBeenCalledWith('hello');
});

test('enter-sends-regression: Enter sends; Shift+Enter does not (survives the CM migration)', () => {
  const onSend = vi.fn();
  render(<ChatPane state={base} {...paneProps} composerText="hello" onSend={onSend} />);
  const composer = composerContent();
  // Shift+Enter must NOT send — it inserts a newline instead.
  fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  // Enter alone sends the trimmed text.
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(onSend).toHaveBeenCalledWith('hello');
});

test('ArrowUp in an EMPTY composer recalls the last sent message; a non-empty composer is untouched', () => {
  const onComposerChange = vi.fn();
  const state: DocChatState = {
    messages: [
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'a reply' },
      { role: 'user', content: 'second ask' },
    ],
    busy: false,
  };
  const { rerender } = render(
    <ChatPane state={state} {...paneProps} composerText="" onComposerChange={onComposerChange} />,
  );
  fireEvent.keyDown(composerContent(), { key: 'ArrowUp' });
  expect(onComposerChange).toHaveBeenCalledWith('second ask'); // the LAST user message, not the first

  // With text already in the composer, ArrowUp is an ordinary caret move — recall must not clobber it.
  onComposerChange.mockClear();
  rerender(<ChatPane state={state} {...paneProps} composerText="half-typed" onComposerChange={onComposerChange} />);
  fireEvent.keyDown(composerContent(), { key: 'ArrowUp' });
  expect(onComposerChange).not.toHaveBeenCalled();
});

test('bold-toggle: Cmd/Ctrl+B wraps the selection in ** and unwraps an already-bold selection', () => {
  const onComposerChange = vi.fn();
  // Wrap: select all of "bold" then Ctrl+B → **bold**.
  const { unmount } = render(
    <ChatPane state={base} {...paneProps} composerText="bold" onComposerChange={onComposerChange} />,
  );
  act(() => composerView().dispatch({ selection: { anchor: 0, head: 4 } }));
  fireEvent.keyDown(composerContent(), { key: 'b', ctrlKey: true });
  // CM's onChange is (value, viewUpdate) — assert on the emitted document text.
  expect(onComposerChange.mock.calls.at(-1)?.[0]).toBe('**bold**');
  unmount();

  // Unwrap: an already-wrapped selection toggles back to bare text.
  onComposerChange.mockClear();
  render(<ChatPane state={base} {...paneProps} composerText="**bold**" onComposerChange={onComposerChange} />);
  act(() => composerView().dispatch({ selection: { anchor: 0, head: 8 } }));
  fireEvent.keyDown(composerContent(), { key: 'b', ctrlKey: true });
  expect(onComposerChange.mock.calls.at(-1)?.[0]).toBe('bold');
});

test('shows an error line', () => {
  render(<ChatPane state={{ ...base, error: 'no ANTHROPIC_API_KEY' }} {...paneProps} />);
  expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
});

test('model selector: default option, config options, and change round-trip', () => {
  const onModelChange = vi.fn();
  render(
    <ChatPane state={base} {...paneProps} modelOptions={['glm-5.2', 'claude-opus-4-8']} onModelChange={onModelChange} />,
  );
  const select = screen.getByLabelText('chat model');
  expect(select).toHaveValue('');
  expect(screen.getByText('default · claude-sonnet-5')).toBeInTheDocument();
  fireEvent.change(select, { target: { value: 'glm-5.2' } });
  expect(onModelChange).toHaveBeenCalledWith('glm-5.2');
  fireEvent.change(select, { target: { value: '' } });
  expect(onModelChange).toHaveBeenCalledWith(undefined);
});

test('a persisted model override missing from the config still renders (and stays selected)', () => {
  render(<ChatPane state={base} {...paneProps} model="gone-model" modelOptions={['glm-5.2']} />);
  expect(screen.getByLabelText('chat model')).toHaveValue('gone-model');
});

test('selector disabled while a turn is in flight', () => {
  render(<ChatPane state={{ ...base, busy: true }} {...paneProps} />);
  expect(screen.getByLabelText('chat model')).toBeDisabled();
});

function composerBox(): HTMLElement {
  return document.querySelector('[data-testid="chat-composer"]') as HTMLElement;
}

test('attach-chip-lifecycle: a pasted image becomes a removable chip and sends as an image attachment', async () => {
  const onSend = vi.fn();
  render(<ChatPane state={base} {...paneProps} composerText="look at this" onSend={onSend} />);
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  // Paste an image into the composer — the chip appears once the FileReader resolves the data URL.
  fireEvent.paste(composerBox(), { clipboardData: { files: [file], items: [] } });
  const chip = await screen.findByTestId('attachment-chip');
  expect(chip).toHaveTextContent('shot.png');

  // The chip rides the send: onSend gets the trimmed text plus one image attachment.
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  expect(onSend).toHaveBeenCalledTimes(1);
  const [text, attachments] = onSend.mock.calls[0]!;
  expect(text).toBe('look at this');
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({ kind: 'image', name: 'shot.png', mediaType: 'image/png' });

  // Re-paste, then remove: the × clears the chip so it never sends.
  fireEvent.paste(composerBox(), { clipboardData: { files: [file], items: [] } });
  const chip2 = await screen.findByTestId('attachment-chip');
  expect(chip2).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /remove attachment shot.png/i }));
  await waitFor(() => expect(screen.queryByTestId('attachment-chip')).toBeNull());
});

test('mention-autocomplete: typing @ filters the tracked-file list and selecting inserts @path', () => {
  const onComposerChange = vi.fn();
  const files = ['src/wire.ts', 'src/api/complete.ts', 'README.md'];
  // The composer is controlled; the mention picker derives from the value. A trailing @wire narrows
  // to the fuzzy-matching tracked files only.
  render(
    <ChatPane
      state={base}
      {...paneProps}
      composerText="see @wire"
      mentionFiles={files}
      onComposerChange={onComposerChange}
    />,
  );
  const list = screen.getByTestId('mention-list');
  expect(list).toHaveTextContent('src/wire.ts');
  expect(list).not.toHaveTextContent('README.md'); // 'wire' doesn't fuzzy-match README.md

  fireEvent.click(screen.getByRole('button', { name: 'src/wire.ts' }));
  // The partial @wire is replaced with the full @path and a trailing space.
  expect(onComposerChange).toHaveBeenCalledWith('see @src/wire.ts ');
});

test('an image attachment on a non-image model surfaces an inline error and blocks send', async () => {
  const onSend = vi.fn();
  render(<ChatPane state={base} {...paneProps} model="glm-5.2" composerText="hi" onSend={onSend} />);
  const file = new File([new Uint8Array([1])], 'p.png', { type: 'image/png' });
  fireEvent.paste(composerBox(), { clipboardData: { files: [file], items: [] } });
  await screen.findByTestId('attachment-chip');
  expect(screen.getByText(/can't read images/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  expect(onSend).not.toHaveBeenCalled();
});

test('oversize-rejection: a dropped text file over the cap is refused with an inline notice', async () => {
  render(<ChatPane state={base} {...paneProps} />);
  const big = new File(['x'.repeat(70_000)], 'big.txt', { type: 'text/plain' });
  fireEvent.drop(composerBox(), { dataTransfer: { files: [big] } });
  expect(await screen.findByText(/too large to attach/i)).toBeInTheDocument();
  expect(screen.queryByTestId('attachment-chip')).toBeNull();
});
