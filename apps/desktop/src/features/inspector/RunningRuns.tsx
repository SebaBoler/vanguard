import { Card, Chip } from '@/ui';
import type { ActiveRun } from '../../vanguard-output';

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export function RunningRuns({
  active,
  onOpen,
}: {
  active: ActiveRun[];
  onOpen: (a: ActiveRun) => void;
}) {
  if (active.length === 0) return null;
  return (
    <div className="space-y-2">
      {active.map((a) => (
        <button key={a.taskId} onClick={() => onOpen(a)} className="block w-full text-left">
          <Card.Root className="border-success/40">
            <Card.Content className="flex items-center gap-2 p-3">
              <span className="size-2 animate-pulse rounded-full bg-success" />
              <span className="font-medium">{a.taskId}</span>
              <Chip color="success" variant="outlined">running</Chip>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{ago(a.lastActivityMs)}</span>
            </Card.Content>
          </Card.Root>
        </button>
      ))}
    </div>
  );
}
