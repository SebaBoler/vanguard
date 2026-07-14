import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPane } from './ChatPane.js';
import type { DocChatState } from './useDocChat.js';

const base: DocChatState = { messages: [{ role: 'user', content: 'plan this' }], busy: false };

test('renders the transcript', () => {
  render(<ChatPane state={base} onSend={() => {}} onAccept={() => {}} onReject={() => {}} />);
  expect(screen.getByText('plan this')).toBeInTheDocument();
});

test('no accept/reject bar without a pending proposal', () => {
  render(<ChatPane state={base} onSend={() => {}} onAccept={() => {}} onReject={() => {}} />);
  expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
});

test('accept/reject bar shows with a pending proposal and fires the callbacks', () => {
  const onAccept = vi.fn();
  const onReject = vi.fn();
  render(<ChatPane state={{ ...base, pending: 'NEW DOC' }} onSend={() => {}} onAccept={onAccept} onReject={onReject} />);
  fireEvent.click(screen.getByRole('button', { name: /accept/i }));
  fireEvent.click(screen.getByRole('button', { name: /reject/i }));
  expect(onAccept).toHaveBeenCalledOnce();
  expect(onReject).toHaveBeenCalledOnce();
});

test('send fires onSend with the trimmed draft', () => {
  const onSend = vi.fn();
  render(<ChatPane state={base} onSend={onSend} onAccept={() => {}} onReject={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(/ask for a plan/i), { target: { value: '  hello  ' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  expect(onSend).toHaveBeenCalledWith('hello');
});

test('shows an error line', () => {
  render(<ChatPane state={{ ...base, error: 'no ANTHROPIC_API_KEY' }} onSend={() => {}} onAccept={() => {}} onReject={() => {}} />);
  expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
});
