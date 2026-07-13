import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FlowCanvas } from './FlowCanvas.js';
import type { FlowDoc } from '../../ipc.js';

const DOC: FlowDoc = {
  name: 'f',
  label: 'L',
  stages: [
    { name: 'planner', overrides: {} },
    { name: 'implementer', overrides: { maxTurns: 9 } },
    { name: 'custom', ref: 'scripts/x.ts#s', overrides: {} },
  ],
  loops: [{ stages: ['planner', 'reviewer'], until: 'reviewer_pass', max: 3 }],
};

const PALETTE = ['planner', 'implementer', 'reviewer'];

test('renders stages in source order with override summary, ref badge, and a read-only loop chip', () => {
  render(<FlowCanvas doc={DOC} palette={PALETTE} selected={null} onSelect={vi.fn()} onMove={vi.fn()} />);
  const blocks = [0, 1, 2].map((i) => screen.getByTestId(`stage-block-${i}`));
  expect(blocks[0]).toHaveTextContent('planner');
  expect(blocks[1]).toHaveTextContent('maxTurns=9');
  expect(blocks[2]).toHaveTextContent('ref');
  expect(screen.getByText(/until reviewer_pass · max 3/)).toBeInTheDocument();
});

test('a stage that is neither a palette name nor a ref carries the fix-me warning', () => {
  const doc: FlowDoc = { ...DOC, stages: [{ name: 'ghost', overrides: {} }], loops: [] };
  render(<FlowCanvas doc={doc} palette={PALETTE} selected={null} onSelect={vi.fn()} onMove={vi.fn()} />);
  expect(screen.getByText(/not in library — pick a name or add a ref/)).toBeInTheDocument();
});

test('◀/▶ buttons and native drag both reorder through onMove (the reducer owns the actual move)', () => {
  const onMove = vi.fn();
  render(<FlowCanvas doc={DOC} palette={PALETTE} selected={null} onSelect={vi.fn()} onMove={onMove} />);

  fireEvent.click(screen.getByRole('button', { name: 'move implementer right' }));
  expect(onMove).toHaveBeenCalledWith(1, 2);
  expect(screen.getByRole('button', { name: 'move planner left' })).toBeDisabled();

  fireEvent.dragStart(screen.getByTestId('stage-block-0'));
  fireEvent.drop(screen.getByTestId('stage-block-2'));
  expect(onMove).toHaveBeenCalledWith(0, 2);
});

test('clicking a block selects it', () => {
  const onSelect = vi.fn();
  render(<FlowCanvas doc={DOC} palette={PALETTE} selected={null} onSelect={onSelect} onMove={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'select implementer' }));
  expect(onSelect).toHaveBeenCalledWith(1);
});
