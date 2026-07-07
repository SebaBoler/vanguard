import { useEffect, useState } from 'react';
import { Button } from 'chunks-ui';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { listRuns, readRun } from '../../ipc';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import type { RunSummary, RunDetail as RunDetailT } from '../../vanguard-output';

export function Inspector({
  project,
  name,
  onExit,
}: {
  project: string;
  name: string;
  onExit: () => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setError(null);
    setDetail(null);
    setLoading(true);
    try {
      setRuns(await listRuns(project));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const open = async (r: RunSummary): Promise<void> => {
    setError(null);
    try {
      setDetail(await readRun(project, r.taskId, r.timestamp));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="text" color="secondary" onClick={onExit} startIcon={<ArrowLeft className="size-4" />}>
          Projects
        </Button>
        <h2 className="font-semibold">{name}</h2>
        <span className="min-w-0 max-w-[20rem] truncate text-sm text-muted-foreground" title={project}>
          {project}
        </span>
        <Button
          className="ml-auto"
          variant="text"
          color="secondary"
          onClick={load}
          loading={loading}
          startIcon={<RefreshCw className="size-4" />}
        >
          Reload
        </Button>
      </div>
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {detail ? (
        <RunDetail detail={detail} onBack={() => setDetail(null)} />
      ) : (
        <RunList runs={runs} onSelect={open} />
      )}
    </div>
  );
}
