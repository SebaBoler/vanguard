import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPane } from './ChatPane.js';
import type { DocChatState } from './useDocChat.js';

const base: DocChatState = { messages: [{ role: 'user', content: 'plan this' }], busy: false };

const paneProps = {
  model: undefined as string | undefined,
  modelOptions: [] as string[],
  defaultModel: 'claude-sonnet-5',
  composerText: '',
  onModelChange: () => {},
  onComposerChange: () => {},
  onSend: () => {},
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

test('enter-sends-shift-newline: Enter sends; Shift+Enter does not (leaves the default newline)', () => {
  const onSend = vi.fn();
  render(<ChatPane state={base} {...paneProps} composerText="hello" onSend={onSend} />);
  const composer = screen.getByPlaceholderText(/plan, scope/i);
  // Shift+Enter must NOT send — the browser default (insert a newline) stands.
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
  fireEvent.keyDown(screen.getByPlaceholderText(/plan, scope/i), { key: 'ArrowUp' });
  expect(onComposerChange).toHaveBeenCalledWith('second ask'); // the LAST user message, not the first

  // With text already in the composer, ArrowUp is an ordinary caret move — recall must not clobber it.
  onComposerChange.mockClear();
  rerender(<ChatPane state={state} {...paneProps} composerText="half-typed" onComposerChange={onComposerChange} />);
  fireEvent.keyDown(screen.getByPlaceholderText(/plan, scope/i), { key: 'ArrowUp' });
  expect(onComposerChange).not.toHaveBeenCalled();
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
