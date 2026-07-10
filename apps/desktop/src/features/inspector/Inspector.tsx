import { useEffect, useRef, useState } from 'react';
import { Button, Chip, cn } from '@/ui';
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
  SPAWN_OUTPUT_EVENT,
  SPAWN_EXIT_EVENT,
} from '../../ipc';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import { LiveRun } from './LiveRun';
import { RemoteRuns } from './RemoteRuns';
import { Fleet } from '../fleet/Fleet';
import { Settings } from '../settings/Settings';
import { TaskBoard } from '../board/TaskBoard';
import { TaskDetail } from '../board/TaskDetail';
import { WorkflowEditor } from '../workflow/WorkflowEditor';
import { NewRunForm } from './NewRunForm';
import { LaunchPanel, type Spawn } from './LaunchPanel';
import { useAppConfig } from '../../hooks';
import { runCommand, runPresets } from '../../command';
import type { RunSummary, RunDetail as RunDetailT, ActiveRun } from '../../vanguard-output';

export function Inspector({
  project,
  screen,
  focusRunning,
  clearNonce,
  onCrumb,
}: {
  project: string;
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
  const [cfg] = useAppConfig(project);
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
    const unOut = listen<{ pid: number; line: string }>(SPAWN_OUTPUT_EVENT, (e) => {
      setSpawns((prev) =>
        prev.map((s) => (s.pid === e.payload.pid ? { ...s, lines: [...s.lines, e.payload.line] } : s)),
      );
    });
    const unExit = listen<{ pid: number; code: number | null }>(SPAWN_EXIT_EVENT, (e) => {
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
    // Fixed-height frame: chrome (toolbar / banners) is shrink-0; the content region below owns scroll.
    // Centered + width-capped, except the board which needs full width for horizontal column scroll.
    <div className={cn('mx-auto flex h-full w-full min-h-0 flex-col gap-4 p-6', screen !== 'board' && 'max-w-5xl')}>
      {screen === 'runs' && (
      <div className="flex shrink-0 items-center gap-3">
        {watching && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Watching .vanguard for changes">
            <span className="size-2 animate-pulse rounded-full bg-success" />
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
        <div className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {showNewRun && (
        <div className="shrink-0">
          <NewRunForm
            defaultCommand={localStorage.getItem(`vg-runcmd:${project}`) ?? runCommand(cfg)}
            presets={runPresets(cfg)}
            onRun={startRun}
            onCancel={() => setShowNewRun(false)}
          />
        </div>
      )}

      {spawns.length > 0 && (
        <div className="shrink-0 space-y-2">
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
        <div className="flex min-h-0 flex-1 flex-col">
          <RunDetail detail={detail} project={project} />
        </div>
      ) : liveRun ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <LiveRun active={liveRun} refreshKey={tick} budgetUsd={cfg.budgetUsd} />
        </div>
      ) : taskDetailId ? (
        // taskDetailId only fires from the board (full-bleed frame) — re-cap width so this reading
        // view matches every other detail view instead of spanning edge-to-edge.
        <div className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto">
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
        </div>
      ) : screen === 'runs' ? (
        // In-flight runs render as running rows at the top of the RunList table.
        <div className="flex min-h-0 flex-1 flex-col">
          <RunList runs={runs} active={active} onSelect={open} onOpenActive={setLiveRun} />
        </div>
      ) : screen === 'board' ? (
        <TaskBoard project={project} onOpenTask={setTaskDetailId} />
      ) : screen === 'remote' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <RemoteRuns project={project} />
        </div>
      ) : screen === 'fleet' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Fleet project={project} active={active} />
        </div>
      ) : screen === 'workflow' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkflowEditor project={project} name={project.split('/').filter(Boolean).pop() ?? project} />
        </div>
      ) : screen === 'settings' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Settings project={project} />
        </div>
      ) : null}
    </div>
  );
}
