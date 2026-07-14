import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPane } from './ChatPane.js';
import type { DocChatState } from './useDocChat.js';

const base: DocChatState = { messages: [{ role: 'user', content: 'plan this' }], busy: false };

test('renders the transcript', () => {
  render(<ChatPane state={base} onSend={() => {}} onAccept={() => {}} onReject={() => {}} />);
  expect(screen.getByText('plan this')).toBeInTheDocument();
});

test('a persisted transcript cannot smuggle an unsafe link scheme through Markdown (review #349 r2)', () => {
  // Drafts can arrive committed inside a cloned repo; the transcript renders through the shared
  // Markdown component, whose react-markdown defaultUrlTransform must keep stripping javascript:.
  const hostile: DocChatState = {
    messages: [{ role: 'assistant', content: '[click me](javascript:alert(1)) and [ok](https://example.com)' }],
    busy: false,
  };
  render(<ChatPane state={hostile} onSend={() => {}} onAccept={() => {}} onReject={() => {}} />);
  const links = screen.getAllByRole('link');
  for (const a of links) {
    expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  }
  expect(links.some((a) => a.getAttribute('href') === 'https://example.com')).toBe(true);
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
