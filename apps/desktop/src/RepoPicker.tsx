import { useEffect, useState } from 'react';
import { ArrowUp, FolderGit2, Folder } from 'lucide-react';
import { Button } from '@/ui';
import { browseDirs } from './ipc';
import type { DirListing } from './vanguard-output';

/** Hub-mode stand-in for the native "Add a repo" folder dialog (no Tauri plugin in a browser):
 * walks `browse_dirs`, confined server-side to the hub's browse root, and adds whichever
 * directory is currently shown. */
export function RepoPicker({ onAdd, onClose }: { onAdd: (path: string) => Promise<void>; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the CURRENTLY SHOWN directory is itself a git work tree — browse_dirs only reports that
  // flag for a listing's children, so this is captured from the row that was clicked to get here
  // (unknown, hence false, at the root and after "up", which the API doesn't flag either).
  const [currentIsGit, setCurrentIsGit] = useState(false);

  const navigate = async (path?: string, isGitRepo = false): Promise<void> => {
    try {
      setListing(await browseDirs(path));
      setCurrentIsGit(isGitRepo);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    navigate();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async (): Promise<void> => {
    if (!listing) return;
    try {
      await onAdd(listing.path);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Button
            variant="text"
            aria-label="Parent directory"
            disabled={!listing?.parent}
            onClick={() => navigate(listing?.parent)}
          >
            <ArrowUp className="size-4" />
          </Button>
          <span className="truncate text-sm text-muted-foreground">{listing?.path ?? 'Loading…'}</span>
        </div>
        <div className="max-h-80 overflow-auto p-1">
          {error && <div className="px-3 py-2 text-sm text-destructive">{error}</div>}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => navigate(entry.path, entry.isGitRepo)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted/60"
            >
              {entry.isGitRepo ? (
                <FolderGit2 className="size-4 text-muted-foreground" />
              ) : (
                <Folder className="size-4 text-muted-foreground" />
              )}
              <span className="truncate">{entry.name}</span>
              <span className="ml-auto flex items-center gap-1 pl-3">
                {entry.isGitRepo && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">git</span>
                )}
                {entry.hasVanguard && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">.vanguard</span>
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={add} disabled={!listing || !currentIsGit}>
            Add this repo
          </Button>
        </div>
      </div>
    </div>
  );
}
