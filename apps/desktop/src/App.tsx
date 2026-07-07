import { useState } from 'react';
import { Button, Chip, ThemeToggle, type Theme } from 'chunks-ui';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { listRuns, readRun } from './ipc';
import { RunList } from './features/inspector/RunList';
import { RunDetail } from './features/inspector/RunDetail';
import type { RunSummary, RunDetail as RunDetailT } from './vanguard-output';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const initial: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(initial);
    return initial;
  });

  const load = async (path: string): Promise<void> => {
    setError(null);
    setDetail(null);
    setLoading(true);
    try {
      setRuns(await listRuns(path));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const pick = async (): Promise<void> => {
    const dir = await open({ directory: true, title: 'Select a repo (contains .vanguard/)' });
    if (typeof dir === 'string') {
      setRepoPath(dir);
      await load(dir);
    }
  };

  const open_ = async (r: RunSummary): Promise<void> => {
    if (repoPath === null) return;
    setError(null);
    try {
      setDetail(await readRun(repoPath, r.taskId, r.timestamp));
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-2.5 backdrop-blur">
        <span className="font-semibold">Vanguard</span>
        <Chip color="secondary" variant="outlined">Inspector</Chip>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {repoPath && (
            <span className="min-w-0 max-w-[18rem] truncate text-sm text-muted-foreground" title={repoPath}>
              {repoPath}
            </span>
          )}
          <Button
            variant={repoPath ? 'outlined' : 'contained'}
            color="secondary"
            onClick={pick}
            loading={loading}
            startIcon={<FolderOpen className="size-4" />}
          >
            {repoPath ? 'Change folder' : 'Open folder…'}
          </Button>
          {repoPath && (
            <Button
              variant="text"
              color="secondary"
              onClick={() => load(repoPath)}
              startIcon={<RefreshCw className="size-4" />}
            >
              Reload
            </Button>
          )}
          <ThemeToggle theme={theme} onClick={toggleTheme} />
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-4">
        {error && (
          <div className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {detail ? (
          <RunDetail detail={detail} onBack={() => setDetail(null)} />
        ) : (
          <RunList runs={runs} onSelect={open_} hasFolder={repoPath !== null} />
        )}
      </main>
    </div>
  );
}
