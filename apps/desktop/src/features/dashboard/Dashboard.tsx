import { Button, Card, Chip, Empty } from 'chunks-ui';
import { FolderPlus, LayoutGrid, X } from 'lucide-react';
import type { Project } from '../../vanguard-output';

function relTime(iso?: string): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Stat({
  label,
  value,
  accent,
  dot,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  dot?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 flex items-center gap-1.5 text-2xl font-semibold tabular-nums ${accent ? 'text-green-600 dark:text-green-400' : ''}`}>
        {dot && <span className="size-2 rounded-full bg-success" />}
        {value}
      </div>
    </div>
  );
}

export function Dashboard({
  projects,
  onOpen,
  onAdd,
  onRemove,
}: {
  projects: Project[];
  onOpen: (p: { path: string; name: string }) => void;
  onAdd: () => void;
  onRemove: (path: string) => void;
}) {
  const totals = {
    projects: projects.length,
    running: projects.reduce((n, p) => n + p.runningCount, 0),
    runs: projects.reduce((n, p) => n + p.runCount, 0),
    last24h: projects.reduce((n, p) => n + p.runsLast24h, 0),
    spend: projects.reduce((n, p) => n + p.totalCostUsd, 0),
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Projects</h2>
        <Button className="ml-auto" onClick={onAdd} startIcon={<FolderPlus className="size-4" />}>
          Add project
        </Button>
      </div>

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
            <Button onClick={onAdd} startIcon={<FolderPlus className="size-4" />}>
              Add project
            </Button>
          </Empty.Actions>
        </Empty.Root>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Projects" value={totals.projects} />
            <Stat label="Running" value={totals.running} accent={totals.running > 0} dot={totals.running > 0} />
            <Stat label="Runs" value={totals.runs} />
            <Stat label="Last 24h" value={totals.last24h} />
            <Stat label="Spend" value={`$${totals.spend.toFixed(2)}`} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                            <span className="size-2 animate-pulse rounded-full bg-success" />
                            {p.runningCount}
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
                        onRemove(p.path);
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
