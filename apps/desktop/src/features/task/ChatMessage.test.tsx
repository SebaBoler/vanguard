import { test, expect, vi, onTestFinished } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatMessage } from './ChatMessage.js';

test('copy-button-per-block: each fenced code block in an assistant reply gets its own copy button', () => {
  const content = 'Here you go:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nand another:\n\n```sh\nls -la\necho hi\n```';
  render(<ChatMessage msg={{ role: 'assistant', content }} />);
  const copyButtons = screen.getAllByRole('button', { name: /copy code/i });
  expect(copyButtons).toHaveLength(2); // one per fenced block, no more
});

test('the copy button copies the block text and shows a brief confirmation', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  // stubGlobal (not Object.assign on the shared navigator) so the mock cannot leak past this test.
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  render(<ChatMessage msg={{ role: 'assistant', content: '```ts\nconst x = 1;\n```' }} />);
  const button = screen.getByRole('button', { name: /copy code/i });
  expect(button).toHaveTextContent(/copy/i);
  fireEvent.click(button);
  expect(writeText).toHaveBeenCalledWith('const x = 1;');
  // The confirmation flips after the clipboard write resolves.
  await screen.findByText(/copied/i);
});

test('the edit affordance appears only when onEdit is supplied, and fires it', () => {
  const onEdit = vi.fn();
  const { rerender } = render(<ChatMessage msg={{ role: 'user', content: 'my ask' }} />);
  expect(screen.queryByRole('button', { name: /edit message/i })).toBeNull();
  rerender(<ChatMessage msg={{ role: 'user', content: 'my ask' }} onEdit={onEdit} />);
  fireEvent.click(screen.getByRole('button', { name: /edit message/i }));
  expect(onEdit).toHaveBeenCalledOnce();
});

test('user messages render verbatim (no markdown), assistant messages through markdown', () => {
  const { rerender } = render(<ChatMessage msg={{ role: 'user', content: '**not bold**' }} />);
  expect(screen.getByText('**not bold**')).toBeInTheDocument(); // literal, not rendered
  rerender(<ChatMessage msg={{ role: 'assistant', content: '**bold**' }} />);
  expect(screen.getByText('bold').tagName).toBe('STRONG');
});
