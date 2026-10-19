import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RepoPicker } from './RepoPicker';
import type { DirListing } from './vanguard-output';

vi.mock('./ipc', () => ({ browseDirs: vi.fn() }));
import { browseDirs } from './ipc';
const mockBrowseDirs = vi.mocked(browseDirs);

const ROOT: DirListing = {
  path: '/root',
  entries: [
    { name: 'git-repo', path: '/root/git-repo', isGitRepo: true, hasVanguard: true },
    { name: 'plain', path: '/root/plain', isGitRepo: false, hasVanguard: false },
  ],
};
const GIT_REPO: DirListing = { path: '/root/git-repo', parent: '/root', entries: [] };
const PLAIN: DirListing = { path: '/root/plain', parent: '/root', entries: [] };

function install(): void {
  mockBrowseDirs.mockImplementation(async (path?: string) => {
    if (path === GIT_REPO.path) return GIT_REPO;
    if (path === PLAIN.path) return PLAIN;
    if (path === ROOT.path || path === undefined) return ROOT;
    throw new Error(`unexpected path ${path}`);
  });
}

describe('RepoPicker', () => {
  test('T-96 badges render per entry, and Add is disabled until a git-repo row is entered', async () => {
    install();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<RepoPicker onAdd={onAdd} onClone={vi.fn()} onClose={() => {}} />);

    await screen.findByText('git-repo');
    const gitRow = screen.getByText('git-repo').closest('button')!;
    const plainRow = screen.getByText('plain').closest('button')!;
    expect(within(gitRow).getByText('git')).toBeInTheDocument();
    expect(within(gitRow).getByText('.vanguard')).toBeInTheDocument();
    expect(within(plainRow).queryByText('git')).not.toBeInTheDocument();
    expect(within(plainRow).queryByText('.vanguard')).not.toBeInTheDocument();

    // Root itself isn't known to be a git repo — Add starts disabled.
    expect(screen.getByRole('button', { name: /add this repo/i })).toBeDisabled();
  });

  test('T-96 navigation: entering a non-git row keeps Add disabled; entering a git row enables it; "up" returns to the parent listing', async () => {
    install();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(<RepoPicker onAdd={onAdd} onClone={vi.fn()} onClose={() => {}} />);

    await screen.findByText('git-repo');
    fireEvent.click(screen.getByText('plain'));
    await screen.findByText('/root/plain');
    expect(screen.getByRole('button', { name: /add this repo/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /parent directory/i }));
    await screen.findByText('git-repo'); // back at root

    fireEvent.click(screen.getByText('git-repo'));
    await screen.findByText('/root/git-repo');
    expect(screen.getByRole('button', { name: /add this repo/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /add this repo/i }));
    expect(onAdd).toHaveBeenCalledWith('/root/git-repo');
  });

  test('T-96 Escape dismisses the picker', async () => {
    install();
    const onClose = vi.fn();
    render(<RepoPicker onAdd={vi.fn()} onClone={vi.fn()} onClose={onClose} />);
    await screen.findByText('git-repo');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
