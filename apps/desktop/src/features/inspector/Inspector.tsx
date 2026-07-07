import { useEffect, useRef, useState } from 'react';
import { Breadcrumb, Button, Chip } from 'chunks-ui';
import { listen } from '@tauri-apps/api/event';
import { Home, RefreshCw } from 'lucide-react';
import { listRuns, listActive, readRun, watchProject, unwatchProject } from '../../ipc';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import { RunningRuns } from './RunningRuns';
import { LiveRun } from './LiveRun';
import type { RunSummary, RunDetail as RunDetailT, ActiveRun } from '../../vanguard-output';

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
  const [active, setActive] = useState<ActiveRun[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [liveRun, setLiveRun] = useState<ActiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(false);
  const [tick, setTick] = useState(0);

  const openRef = useRef<{ taskId: string; timestamp: string } | null>(null);
  useEffect(() => {
    openRef.current = detail ? { taskId: detail.taskId, timestamp: detail.timestamp } : null;
  }, [detail]);

  const load = async (): Promise<void> => {
    setError(null);
    setDetail(null);
    setLiveRun(null);
    setLoading(true);
    try {
      const [r, a] = await Promise.all([listRuns(project), listActive(project)]);
      setRuns(r);
      setActive(a);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      const [r, a] = await Promise.all([listRuns(project), listActive(project)]);
      setRuns(r);
      setActive(a);
      setTick((t) => t + 1);
      const o = openRef.current;
      if (o) setDetail(await readRun(project, o.taskId, o.timestamp));
    } catch {
      // transient mid-write; next event resyncs
    }
  };

  useEffect(() => {
    void load();
    void watchProject(project)
      .then(() => setWatching(true))
      .catch(() => setWatching(false));
    const unlisten = listen<string>('vanguard:changed', (e) => {
      if (e.payload === project) void refresh();
    });
    return () => {
      setWatching(false);
      void unwatchProject(project);
      void unlisten.then((f) => f());
    };
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

  const clearRun = (): void => {
    setDetail(null);
    setLiveRun(null);
  };

  const runTaskId = detail?.taskId ?? liveRun?.taskId ?? null;
  const detailPassed =
    detail && (detail.proof ? detail.proof.passed : !detail.stages.some((s) => !s.record.completed));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Breadcrumb.Root>
          <Breadcrumb.List>
            <Breadcrumb.Item>
              <Breadcrumb.Link onClick={onExit} className="flex cursor-pointer items-center" title="Projects">
                <Home className="size-4" />
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator />
            <Breadcrumb.Item>
              {runTaskId ? (
                <Breadcrumb.Link onClick={clearRun} className="cursor-pointer" title={project}>
                  {name}
                </Breadcrumb.Link>
              ) : (
                <Breadcrumb.Page title={project}>{name}</Breadcrumb.Page>
              )}
            </Breadcrumb.Item>
            {runTaskId && (
              <>
                <Breadcrumb.Separator />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{runTaskId}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb.Root>

        {watching && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Watching .vanguard for changes">
            <span className="size-2 animate-pulse rounded-full bg-green-500" />
            live
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {detail && <span className="tabular-nums text-xs text-muted-foreground">{detail.timestamp}</span>}
          {liveRun && <Chip color="success" variant="outlined">running</Chip>}
          {detail && <Chip color={detailPassed ? 'success' : 'destructive'}>{detailPassed ? 'passed' : 'failed'}</Chip>}
          <Button variant="text" color="secondary" onClick={load} loading={loading} startIcon={<RefreshCw className="size-4" />}>
            Reload
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {detail ? (
        <RunDetail detail={detail} />
      ) : liveRun ? (
        <LiveRun active={liveRun} refreshKey={tick} />
      ) : (
        <>
          <RunningRuns active={active} onOpen={setLiveRun} />
          <RunList runs={runs} onSelect={open} />
        </>
      )}
    </div>
  );
}
