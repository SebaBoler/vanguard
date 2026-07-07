import { useEffect, useRef, useState } from 'react';
import { Button } from 'chunks-ui';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, RefreshCw } from 'lucide-react';
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
  // Bumped on each file-change event so the open LiveRun re-reads its session.
  const [tick, setTick] = useState(0);

  // Track the open completed run in a ref so the change listener re-reads the right one
  // without re-subscribing on every state change.
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

  // Silent refresh on file changes — keep the current view, no spinner.
  const refresh = async (): Promise<void> => {
    try {
      const [r, a] = await Promise.all([listRuns(project), listActive(project)]);
      setRuns(r);
      setActive(a);
      setTick((t) => t + 1); // re-read the open LiveRun's session
      const o = openRef.current;
      if (o) setDetail(await readRun(project, o.taskId, o.timestamp));
    } catch {
      // transient mid-write; the next debounced event resyncs
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="text" color="secondary" onClick={onExit} startIcon={<ArrowLeft className="size-4" />}>
          Projects
        </Button>
        <h2 className="font-semibold">{name}</h2>
        {watching && (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground"
            title="Watching .vanguard for changes"
          >
            <span className="size-2 animate-pulse rounded-full bg-green-500" />
            live
          </span>
        )}
        <span className="ml-auto min-w-0 max-w-[20rem] truncate text-sm text-muted-foreground" title={project}>
          {project}
        </span>
        <Button
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
      ) : liveRun ? (
        <LiveRun active={liveRun} refreshKey={tick} onBack={() => setLiveRun(null)} />
      ) : (
        <>
          <RunningRuns active={active} onOpen={setLiveRun} />
          <RunList runs={runs} onSelect={open} />
        </>
      )}
    </div>
  );
}
