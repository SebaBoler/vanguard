import { useEffect, useRef, useState } from 'react';
import { Button, Chip } from 'chunks-ui';
import { listen } from '@tauri-apps/api/event';
import { Play, RefreshCw } from 'lucide-react';
import {
  listRuns,
  listActive,
  readRun,
  spawnRun,
  killRun,
  watchProject,
  unwatchProject,
} from '../../ipc';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import { RunningRuns } from './RunningRuns';
import { LiveRun } from './LiveRun';
import { RemoteRuns } from './RemoteRuns';
import { Fleet } from '../fleet/Fleet';
import { Settings } from '../settings/Settings';
import { TaskBoard } from '../board/TaskBoard';
import { TaskDetail } from '../board/TaskDetail';
import { WorkflowEditor } from '../workflow/WorkflowEditor';
import { NewRunForm } from './NewRunForm';
import { LaunchPanel, type Spawn } from './LaunchPanel';
import type { RunSummary, RunDetail as RunDetailT, ActiveRun } from '../../vanguard-output';

const DEFAULT_CMD = 'vanguard run --github <issue> --provider zai --llm-proxy';

export function Inspector({
  project,
  name,
  screen,
  focusRunning,
  clearNonce,
  onCrumb,
}: {
  project: string;
  name: string;
  screen: 'runs' | 'board' | 'fleet' | 'remote' | 'workflow' | 'settings';
  focusRunning: ActiveRun | null;
  clearNonce: number;
  onCrumb: (c: string | null) => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [active, setActive] = useState<ActiveRun[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [liveRun, setLiveRun] = useState<ActiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [watching, setWatching] = useState(false);
  const [tick, setTick] = useState(0);
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const [showNewRun, setShowNewRun] = useState(false);
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);

  const openRef = useRef<{ taskId: string; timestamp: string } | null>(null);
  useEffect(() => {
    openRef.current = detail ? { taskId: detail.taskId, timestamp: detail.timestamp } : null;
  }, [detail]);

  // Rail navigation drops any open drill-down.
  useEffect(() => {
    setDetail(null);
    setLiveRun(null);
    setTaskDetailId(null);
  }, [screen]);

  // The rail "Running" click opens that live run.
  useEffect(() => {
    if (focusRunning) setLiveRun(focusRunning);
  }, [focusRunning]);

  // Report the current drill-down up to the top-bar breadcrumb.
  useEffect(() => {
    onCrumb(detail ? detail.taskId : liveRun ? liveRun.taskId : (taskDetailId ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, liveRun, taskDetailId]);

  // A breadcrumb crumb click clears the open drill-down.
  useEffect(() => {
    if (clearNonce > 0) {
      setDetail(null);
      setLiveRun(null);
      setTaskDetailId(null);
    }
  }, [clearNonce]);

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

  // Spawned-run output/exit streams.
  useEffect(() => {
    const unOut = listen<{ pid: number; line: string }>('spawn:output', (e) => {
      setSpawns((prev) =>
        prev.map((s) => (s.pid === e.payload.pid ? { ...s, lines: [...s.lines, e.payload.line] } : s)),
      );
    });
    const unExit = listen<{ pid: number; code: number | null }>('spawn:exit', (e) => {
      setSpawns((prev) => prev.map((s) => (s.pid === e.payload.pid ? { ...s, exit: e.payload.code } : s)));
    });
    return () => {
      void unOut.then((f) => f());
      void unExit.then((f) => f());
    };
  }, []);

  const startRun = async (command: string): Promise<void> => {
    localStorage.setItem(`vg-runcmd:${project}`, command);
    setShowNewRun(false);
    setError(null);
    try {
      const pid = await spawnRun(project, command);
      setSpawns((prev) => [...prev, { pid, command, lines: [] }]);
    } catch (e) {
      setError(String(e));
    }
  };

  const open = async (r: RunSummary): Promise<void> => {
    setError(null);
    try {
      setDetail(await readRun(project, r.taskId, r.timestamp));
    } catch (e) {
      setError(String(e));
    }
  };

  const detailPassed =
    detail && (detail.proof ? detail.proof.passed : !detail.stages.some((s) => !s.record.completed));

  return (
    <div className="space-y-4">
      {screen === 'runs' && (
      <div className="flex items-center gap-3">
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
          <Button
            variant="outlined"
            color="secondary"
            onClick={() => setShowNewRun((v) => !v)}
            startIcon={<Play className="size-4" />}
          >
            New run
          </Button>
          <Button variant="text" color="secondary" onClick={load} loading={loading} startIcon={<RefreshCw className="size-4" />}>
            Reload
          </Button>
        </div>
      </div>
      )}

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {showNewRun && (
        <NewRunForm
          defaultCommand={localStorage.getItem(`vg-runcmd:${project}`) ?? DEFAULT_CMD}
          onRun={startRun}
          onCancel={() => setShowNewRun(false)}
        />
      )}

      {spawns.length > 0 && (
        <div className="space-y-2">
          {spawns.map((s) => (
            <LaunchPanel
              key={s.pid}
              spawn={s}
              onKill={(pid) => void killRun(pid)}
              onDismiss={(pid) => setSpawns((prev) => prev.filter((x) => x.pid !== pid))}
            />
          ))}
        </div>
      )}

      {detail ? (
        <RunDetail detail={detail} project={project} />
      ) : liveRun ? (
        <LiveRun active={liveRun} refreshKey={tick} />
      ) : taskDetailId ? (
        <TaskDetail
          project={project}
          taskId={taskDetailId}
          runs={runs}
          onBack={() => setTaskDetailId(null)}
          onNewRun={() => {
            setTaskDetailId(null);
            setShowNewRun(true);
          }}
        />
      ) : (
        <>
          {screen === 'runs' && (
            <>
              <RunningRuns active={active} onOpen={setLiveRun} />
              <RunList runs={runs} onSelect={open} />
            </>
          )}
          {screen === 'board' && <TaskBoard project={project} onOpenTask={setTaskDetailId} />}
          {screen === 'fleet' && <Fleet project={project} active={active} />}
          {screen === 'remote' && <RemoteRuns project={project} />}
          {screen === 'workflow' && <WorkflowEditor project={project} name={name} />}
          {screen === 'settings' && <Settings project={project} />}
        </>
      )}
    </div>
  );
}
