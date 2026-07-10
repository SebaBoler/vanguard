import { Card, Chip } from '@/ui';
import type { ActiveRun } from '../../vanguard-output';
import { relTime } from '../../time';

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
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{relTime(a.lastActivityMs)}</span>
            </Card.Content>
          </Card.Root>
        </button>
      ))}
    </div>
  );
}
