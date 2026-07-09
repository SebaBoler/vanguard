import { Button, Card, Chip } from 'chunks-ui';
import { ArrowLeft, Play } from 'lucide-react';
import type { RunSummary } from '../../vanguard-output';
import { SpecPane } from '../inspector/SpecPane';
import { taskRefKey } from './taskref';

export function TaskDetail({
  project,
  taskId,
  runs,
  onBack,
  onNewRun,
}: {
  project: string;
  taskId: string;
  runs: RunSummary[];
  onBack: () => void;
  onNewRun: () => void;
}) {
  // Board ids are minted bare (gh-904); run records may carry a repo slug (gh-owner-repo-904).
  // Match on the normalized source-ref key so history isn't silently empty.
  const key = taskRefKey(taskId);
  const history = runs.filter((r) => taskRefKey(r.taskId) === key);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="text" color="secondary" onClick={onBack} startIcon={<ArrowLeft className="size-4" />}>
          Board
        </Button>
        <span className="font-mono font-semibold">{taskId}</span>
        <Button className="ml-auto" onClick={onNewRun} startIcon={<Play className="size-4" />}>
          New Run
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Card.Root>
          <Card.Content className="p-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Spec — from source
            </div>
            <SpecPane project={project} taskId={taskId} />
          </Card.Content>
        </Card.Root>

        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Run history
          </div>
          <div className="space-y-2">
            {history.length === 0 ? (
              <div className="text-sm text-muted-foreground">No runs yet.</div>
            ) : (
              history.map((r) => (
                <div key={r.timestamp} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="tabular-nums text-sm text-muted-foreground">
                      {r.timestamp.replace('T', ' ').slice(0, 16)}
                    </span>
                    <Chip color={r.anyFailed ? 'destructive' : 'success'} variant="outlined">
                      {r.anyFailed ? 'failed' : 'passed'}
                    </Chip>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{r.stages.join(', ')}</span>
                    <span className="tabular-nums">${r.totalCostUsd.toFixed(2)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
