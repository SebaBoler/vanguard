import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Fleet } from './Fleet';

vi.mock('../../ipc', () => ({
  listSpawns: vi.fn(async () => []),
  spawnRun: vi.fn(),
  killRun: vi.fn(),
  SPAWN_OUTPUT_EVENT: 'spawn:output',
  SPAWN_EXIT_EVENT: 'spawn:exit',
}));
vi.mock('../../transport', () => ({ subscribe: vi.fn(async () => () => {}) }));
vi.mock('../../hooks', () => ({ useAppConfig: () => [{}] }));

describe('Fleet slot meter — waiting count (T18–T20)', () => {
  test('T18: a known waiting count renders next to the slot meter', () => {
    render(<Fleet project="/repo" active={[]} waiting={4} />);
    expect(screen.getByText('Slots 0 / 3 in use · 4 waiting')).toBeInTheDocument();
  });

  test('T19: an unknown count (null) renders the bare meter and no waiting text', () => {
    render(<Fleet project="/repo" active={[]} waiting={null} />);
    expect(screen.getByText('Slots 0 / 3 in use')).toBeInTheDocument();
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
  });

  test('T20: a known zero is a real answer — only null suppresses', () => {
    render(<Fleet project="/repo" active={[]} waiting={0} />);
    expect(screen.getByText('Slots 0 / 3 in use · 0 waiting')).toBeInTheDocument();
  });
});
