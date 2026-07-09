import { Card, Chip } from 'chunks-ui';
import { listTasks } from '../../ipc';
import { useAsync } from '../../hooks';

const COLUMNS = ['queued', 'claimed', 'running', 'verify-failed', 'review', 'done'];

function chipColor(col: string): 'primary' | 'destructive' | 'success' | 'warning' | 'secondary' {
  if (col === 'running' || col === 'done') return 'success';
  if (col === 'verify-failed') return 'destructive';
  if (col === 'review') return 'primary';
  if (col === 'claimed') return 'warning';
  return 'secondary';
}

export function TaskBoard({ project, onOpenTask }: { project: string; onOpenTask: (taskId: string) => void }) {
  const { data: tasks, error, loading } = useAsync(() => listTasks(project), [project]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading tasks…</div>;
  if (error) {
    return (
      <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        No task board. {error}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-4">
      {COLUMNS.map((col) => {
        const items = (tasks ?? []).filter((t) => t.column === col);
        return (
          <div key={col} className="flex h-full min-h-0 w-64 shrink-0 flex-col">
            <div className="mb-2 flex shrink-0 items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {col}
              <span className="rounded bg-muted px-1.5 tabular-nums">{items.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {items.map((t) => (
                <button key={t.id} onClick={() => onOpenTask(t.id)} className="block w-full text-left">
                  <Card.Root className="transition-colors hover:border-primary/40">
                    <Card.Content className="space-y-1 p-3">
                      <div className="font-mono text-xs font-medium">{t.id}</div>
                      <div className="text-sm">{t.title}</div>
                      <Chip color={chipColor(col)} variant="outlined">{t.state || col}</Chip>
                    </Card.Content>
                  </Card.Root>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
