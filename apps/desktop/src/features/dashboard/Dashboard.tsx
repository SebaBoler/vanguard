import { useEffect, useState } from 'react';
import { Button, Card, Empty } from 'chunks-ui';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderPlus, LayoutGrid, X } from 'lucide-react';
import { listProjects, addProject, removeProject } from '../../ipc';
import type { Project } from '../../vanguard-output';

/** `2026-07-06T19:12:02.123Z` -> `2026-07-06 19:12`. */
function shortTime(ts: string): string {
  return ts.replace('T', ' ').slice(0, 16);
}

export function Dashboard({ onOpen }: { onOpen: (p: { path: string; name: string }) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const add = async (): Promise<void> => {
    setError(null);
    try {
      const dir = await open({ directory: true, title: 'Add a repo (contains .vanguard/)' });
      if (typeof dir === 'string') setProjects(await addProject(dir));
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (path: string): Promise<void> => {
    setError(null);
    try {
      setProjects(await removeProject(path));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Projects</h2>
        <Button className="ml-auto" onClick={add} startIcon={<FolderPlus className="size-4" />}>
          Add project
        </Button>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {projects.length === 0 ? (
        <Empty.Root>
          <Empty.Media>
            <LayoutGrid />
          </Empty.Media>
          <Empty.Title>No projects yet</Empty.Title>
          <Empty.Description>
            Add a repo containing <code>.vanguard/runs</code> to track its runs and spend.
          </Empty.Description>
          <Empty.Actions>
            <Button onClick={add} startIcon={<FolderPlus className="size-4" />}>
              Add project
            </Button>
          </Empty.Actions>
        </Empty.Root>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <Card.Root
              key={p.path}
              onClick={() => onOpen({ path: p.path, name: p.name })}
              className="cursor-pointer transition-colors hover:border-primary/40"
            >
              <Card.Header className="flex flex-row items-start justify-between gap-2 pb-2">
                <div className="min-w-0">
                  <Card.Title className="truncate">{p.name}</Card.Title>
                  <Card.Description className="truncate" title={p.path}>
                    {p.path}
                  </Card.Description>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(p.path);
                  }}
                  aria-label={`Remove ${p.name}`}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                >
                  <X className="size-4" />
                </button>
              </Card.Header>
              <Card.Content className="pt-0">
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                  <span>{p.runCount} runs</span>
                  <span>{p.taskCount} tasks</span>
                  <span>${p.totalCostUsd.toFixed(2)}</span>
                  {p.failedCount > 0 && <span className="text-destructive">{p.failedCount} failed</span>}
                  {p.lastRun && <span>· {shortTime(p.lastRun)}</span>}
                </div>
              </Card.Content>
            </Card.Root>
          ))}
        </div>
      )}
    </div>
  );
}
