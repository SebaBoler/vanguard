import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InlineEdit } from './InlineEdit.js';

test('click to edit, Enter commits the trimmed value', () => {
  const onCommit = vi.fn();
  render(<InlineEdit value="Old" placeholder="Name it…" ariaLabel="task title" onCommit={onCommit} />);
  fireEvent.click(screen.getByLabelText('task title'));
  const input = screen.getByLabelText('task title input');
  fireEvent.change(input, { target: { value: '  New name  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onCommit).toHaveBeenCalledWith('New name');
  // Back to display mode.
  expect(screen.queryByLabelText('task title input')).toBeNull();
});

test('Escape cancels without committing; blur commits', () => {
  const onCommit = vi.fn();
  render(<InlineEdit value="Old" placeholder="Name it…" ariaLabel="task title" onCommit={onCommit} />);
  fireEvent.click(screen.getByLabelText('task title'));
  fireEvent.change(screen.getByLabelText('task title input'), { target: { value: 'discard me' } });
  fireEvent.keyDown(screen.getByLabelText('task title input'), { key: 'Escape' });
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('task title'));
  fireEvent.change(screen.getByLabelText('task title input'), { target: { value: 'via blur' } });
  fireEvent.blur(screen.getByLabelText('task title input'));
  expect(onCommit).toHaveBeenCalledWith('via blur');
});

test('empty value shows the placeholder; disabled renders static text with no edit affordance', () => {
  const { rerender } = render(<InlineEdit value="" placeholder="Name it…" ariaLabel="t" onCommit={() => {}} />);
  expect(screen.getByText('Name it…')).toBeInTheDocument();
  rerender(<InlineEdit value="Locked" placeholder="Name it…" ariaLabel="t" disabled onCommit={() => {}} />);
  expect(screen.getByText('Locked')).toBeInTheDocument();
  expect(screen.queryByLabelText('t')).toBeNull(); // no button
});
