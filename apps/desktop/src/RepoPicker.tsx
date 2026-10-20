import { useEffect, useState } from 'react';
import { ArrowUp, FolderGit2, Folder } from 'lucide-react';
import { Button, Input, Tabs } from '@/ui';
import { browseDirs } from './ipc';
import { subscribe } from './transport';
import type { DirListing } from './vanguard-output';

type Mode = 'existing' | 'clone';

/** Hub-mode stand-in for the native "Add a repo" folder dialog (no Tauri plugin in a browser):
 * walks `browse_dirs`, confined server-side to the hub's browse root. Two modes share the same
 * browser: **Existing folder** adds whichever git work tree is currently shown (unchanged
 * behavior); **Clone repository** clones a pasted URL into the shown folder as the parent dir. */
export function RepoPicker({
  onAdd,
  onClone,
  onClose,
}: {
  onAdd: (path: string) => Promise<void>;
  onClone: (url: string, parentDir: string, name?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('existing');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the CURRENTLY SHOWN directory is itself a git work tree — browse_dirs only reports that
  // flag for a listing's children, so this is captured from the row that was clicked to get here
  // (unknown, hence false, at the root and after "up", which the API doesn't flag either).
  const [currentIsGit, setCurrentIsGit] = useState(false);

  const [url, setUrl] = useState('');
  const [folderName, setFolderName] = useState('');
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);

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

  // Only wired up while a clone is in flight — the dialog has no reason to hold the SSE
  // subscription open the rest of the time.
  useEffect(() => {
    if (!cloning) return;
    let unlisten: (() => void) | undefined;
    void subscribe<{ line: string }>('vanguard:clone-progress', (e) => {
      setProgress((lines) => [...lines, e.payload.line]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [cloning]);

  const add = async (): Promise<void> => {
    if (!listing) return;
    try {
      await onAdd(listing.path);
    } catch (err) {
      setError(String(err));
    }
  };

  const clone = async (): Promise<void> => {
    if (!listing || url.trim() === '') return;
    setError(null);
    setProgress([]);
    setCloning(true);
    try {
      await onClone(url.trim(), listing.path, folderName.trim() || undefined);
    } catch (err) {
      setError(String(err));
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Tabs.Root value={mode} onValueChange={(v) => setMode(v as Mode)} className="flex flex-col">
          <Tabs.List className="shrink-0 px-3 pt-2">
            <Tabs.Tab value="existing">Existing folder</Tabs.Tab>
            <Tabs.Tab value="clone">Clone repository</Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>

          {mode === 'clone' && (
            <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
              <Input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                disabled={cloning}
              />
              <Input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="Folder name (default: repo name)"
                disabled={cloning}
              />
            </div>
          )}

          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button
              variant="text"
              aria-label="Parent directory"
              disabled={!listing?.parent || cloning}
              onClick={() => navigate(listing?.parent)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <span className="truncate text-sm text-muted-foreground">
              {mode === 'clone' ? `Clone into: ${listing?.path ?? 'Loading…'}` : listing?.path ?? 'Loading…'}
            </span>
          </div>
          <div className="max-h-80 overflow-auto p-1">
            {error && <div className="px-3 py-2 text-sm text-destructive">{error}</div>}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => navigate(entry.path, entry.isGitRepo)}
                disabled={cloning}
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

          {mode === 'clone' && progress.length > 0 && (
            <div className="max-h-24 overflow-auto border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              {progress.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
            <Button variant="text" onClick={onClose} disabled={cloning}>
              Cancel
            </Button>
            {mode === 'existing' ? (
              <Button onClick={add} disabled={!listing || !currentIsGit}>
                Add this repo
              </Button>
            ) : (
              <Button onClick={clone} disabled={!listing || url.trim() === '' || cloning}>
                {cloning ? 'Cloning…' : 'Clone & add'}
              </Button>
            )}
          </div>
        </Tabs.Root>
      </div>
    </div>
  );
}
