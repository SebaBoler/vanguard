import { useState } from 'react';
import { Button, Input, Chip, ThemeToggle, type Theme } from 'chunks-ui';
import { FolderGit2, RefreshCw } from 'lucide-react';
import { listRuns, readRun } from './ipc';
import { RunList } from './features/inspector/RunList';
import { RunDetail } from './features/inspector/RunDetail';
import type { RunSummary, RunDetail as RunDetailT } from './vanguard-output';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export default function App() {
  const [repoPath, setRepoPath] = useState('.');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const initial: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(initial);
    return initial;
  });

  const load = async (): Promise<void> => {
    setError(null);
    setDetail(null);
    setLoading(true);
    try {
      setRuns(await listRuns(repoPath));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const open = async (r: RunSummary): Promise<void> => {
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
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            startAdornment={<FolderGit2 className="size-4" />}
            placeholder="repo path (.vanguard/)"
            className="w-64"
          />
          <Button onClick={load} loading={loading} startIcon={<RefreshCw className="size-4" />}>
            Load
          </Button>
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
          <RunList runs={runs} onSelect={open} />
        )}
      </main>
    </div>
  );
}
