import { useEffect, useState } from 'react';
import { Button, Card, Chip, Empty } from 'chunks-ui';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderPlus, LayoutGrid, X } from 'lucide-react';
import { listProjects, addProject, removeProject } from '../../ipc';
import type { Project } from '../../vanguard-output';

function relTime(iso?: string): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${accent ? 'text-green-600 dark:text-green-400' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export function Dashboard({ onOpen }: { onOpen: (p: { path: string; name: string }) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Poll so running counts + metrics stay live. ponytail: re-aggregates every project's runs
  // each tick — fine for a handful of projects; cache/watch if the list grows large.
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      listProjects()
        .then((p) => {
          if (alive) setProjects(p);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
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

  const totals = {
    projects: projects.length,
    running: projects.reduce((n, p) => n + p.runningCount, 0),
    runs: projects.reduce((n, p) => n + p.runCount, 0),
    last24h: projects.reduce((n, p) => n + p.runsLast24h, 0),
    spend: projects.reduce((n, p) => n + p.totalCostUsd, 0),
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
        <>
          <div className="flex flex-wrap gap-6 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <Stat label="Projects" value={totals.projects} />
            <Stat label="Running" value={totals.running} accent={totals.running > 0} />
            <Stat label="Runs" value={totals.runs} />
            <Stat label="Last 24h" value={totals.last24h} />
            <Stat label="Spend" value={`$${totals.spend.toFixed(2)}`} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => {
              const last = relTime(p.lastRun);
              return (
                <Card.Root
                  key={p.path}
                  onClick={() => onOpen({ path: p.path, name: p.name })}
                  className="cursor-pointer transition-colors hover:border-primary/40"
                >
                  <Card.Header className="flex flex-row items-start justify-between gap-2 pb-2">
                    <div className="min-w-0">
                      <Card.Title className="flex items-center gap-2 truncate">
                        {p.name}
                        {p.runningCount > 0 && (
                          <span className="flex items-center gap-1 text-xs font-normal text-green-600 dark:text-green-400">
                            <span className="size-2 animate-pulse rounded-full bg-green-500" />
                            {p.runningCount} running
                          </span>
                        )}
                      </Card.Title>
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
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                      <span>{p.runCount} runs</span>
                      <span>{p.taskCount} tasks</span>
                      <span>${p.totalCostUsd.toFixed(2)}</span>
                      {p.failedCount > 0 && <span className="text-destructive">{p.failedCount} failed</span>}
                      {p.runsLast24h > 0 && <Chip color="secondary" variant="outlined">{p.runsLast24h} in 24h</Chip>}
                      {last && <span className="ml-auto">{last}</span>}
                    </div>
                  </Card.Content>
                </Card.Root>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
