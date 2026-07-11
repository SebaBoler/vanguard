import { useEffect, useRef, useState } from 'react';
import { Button, Chip, cn } from '@/ui';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Play, RefreshCw } from 'lucide-react';
import {
  listRuns,
  listActive,
  readRun,
  killRun,
  watchProject,
  unwatchProject,
  apiCapabilitiesCached,
  apiCreateRun,
  apiActiveRun,
  apiRunBacklog,
  apiCancel,
  SPAWN_OUTPUT_EVENT,
  SPAWN_EXIT_EVENT,
  type Capabilities,
  type CreateRunParams,
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
import { RunStrip } from './RunStrip';
import { reduceTypedRun, initialTypedRun, type TypedRunState, type RunEvent } from './typedRunReducer';
import { LaunchPanel, type Spawn } from './LaunchPanel';
import { useAppConfig } from '../../hooks';
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
  const [focusedSpawn, setFocusedSpawn] = useState<number | null>(null);
  const [showNewRun, setShowNewRun] = useState(false);
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);
  // Typed run (S1): capabilities for the form, the single in-flight typed run, and the idle-check.
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [typedRun, setTypedRun] = useState<TypedRunState | null>(null);
  const [checkedIdle, setCheckedIdle] = useState(false); // false until apiActiveRun() resolves on mount
  const typedRunRef = useRef<TypedRunState | null>(null); // latest typedRun, readable in async callbacks
  const dismissedRunId = useRef<string | null>(null); // a run the user closed — ignore its late events

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

  // Load the capability surface once (cached; pure — never blocks on a live run).
  useEffect(() => {
    void apiCapabilitiesCached().then(setCaps).catch(() => setCaps(null));
  }, []);

  // Mirror typedRun into a ref so async callbacks (the apiCreateRun catch) can read the latest value.
  useEffect(() => {
    typedRunRef.current = typedRun;
  }, [typedRun]);

  // Subscribe to the typed-run event stream and fold into `typedRun` (reducer drops foreign runIds).
  // Ignore events for a run the user has dismissed, so a late event can't resurrect a closed strip.
  useEffect(() => {
    const un = listen<{ runId: string; event: RunEvent }>('api:event', (e) => {
      if (e.payload.runId === dismissedRunId.current) return;
      setTypedRun((prev) => reduceTypedRun(prev ?? initialTypedRun(), e.payload));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // On mount, learn whether a typed run is already in flight and re-attach its strip by replaying the
  // buffered backlog. Runs after the listen effect so the live tail isn't lost. Fold the backlog INTO
  // current state (not replace) so events that arrived on the channel during the await aren't dropped;
  // the reducer's last-wins keys + idempotence make the merge safe.
  useEffect(() => {
    void apiActiveRun().then(async (id) => {
      setCheckedIdle(true);
      if (id === null) return;
      const backlog = (await apiRunBacklog(id)) as { runId: string; event: RunEvent }[];
      setTypedRun((prev) => backlog.reduce((s, p) => reduceTypedRun(s, p), prev ?? initialTypedRun()));
    });
  }, []);

  const startTypedRun = (params: CreateRunParams): void => {
    setShowNewRun(false);
    setError(null);
    setTypedRun(initialTypedRun()); // synchronous in-flight marker ("starting…") — "run live" derives from this
    setDetail(null);
    setLiveRun(null);
    setFocusedSpawn(null);
    void apiCreateRun(params)
      .then((res) => {
        // The event stream owns the terminal; this is a backstop only if the terminal event was lost —
        // write it ONLY when still non-terminal, so it never double-renders over a folded terminal.
        setTypedRun((prev) =>
          prev !== null && prev.terminal === undefined
            ? { ...prev, terminal: res.secretBlocked === true ? { kind: 'secret-blocked' } : res.prUrl !== undefined ? { kind: 'success', prUrl: res.prUrl } : { kind: 'no-changes' } }
            : prev,
        );
      })
      .catch((e) => {
        // apiCreateRun rejects on BOTH a pre-start rejection (the Rust single-in-flight guard, which
        // returns Err before any run-accepted event) AND a run that started then errored/cancelled
        // (resolve_terminal returns Err for those). Only the former needs clearing + a banner — it never
        // adopted a runId. A real error/cancel already folded run-accepted, so its runId is set and the
        // terminal EVENT renders it in the strip; don't wipe it or double-report.
        if (typedRunRef.current?.runId === undefined) {
          setError(String(e));
          setTypedRun(null);
        }
      });
  };

  const open = async (r: RunSummary): Promise<void> => {
    setError(null);
    setFocusedSpawn(null);
    try {
      setDetail(await readRun(project, r.taskId, r.timestamp));
    } catch (e) {
      setError(String(e));
    }
  };

  const detailPassed =
    detail && (detail.proof ? detail.proof.passed : !detail.stages.some((s) => !s.record.completed));

  // The launch whose live log is open (may be running or just-exited until dismissed).
  const focusedSpawnEntry = focusedSpawn !== null ? spawns.find((s) => s.pid === focusedSpawn) : undefined;

  // Suppress the session-based `active` row for the typed run in flight (join key is taskId).
  const liveTaskId = typedRun?.taskId;
  const activeShown = liveTaskId !== undefined ? active.filter((a) => a.taskId !== liveTaskId) : active;

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
            // Single-in-flight: disabled until the mount idle-check resolves, and while a typed run is
            // live (in-flight derives from typedRun.terminal — the listener updates it, so re-attach and
            // run-end both clear the guard). No write-once busy latch.
            disabled={!checkedIdle || (typedRun !== null && typedRun.terminal === undefined)}
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

      {showNewRun && caps !== null && (
        <div className="shrink-0">
          <NewRunForm capabilities={caps} project={project} onRun={startTypedRun} onCancel={() => setShowNewRun(false)} />
        </div>
      )}

      {typedRun !== null && screen === 'runs' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {typedRun.terminal !== undefined && (
            <button
              onClick={() => {
                // Record the runId as dismissed so a late event can't resurrect the closed strip.
                if (typedRun.runId !== undefined) dismissedRunId.current = typedRun.runId;
                setTypedRun(null);
              }}
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Back to runs
            </button>
          )}
          <RunStrip state={typedRun} onCancel={() => void apiCancel()} />
        </div>
      ) : detail ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <RunDetail detail={detail} project={project} />
        </div>
      ) : focusedSpawnEntry ? (
        // A running launch clicked in the list: its live log + Kill, with a way back to the table.
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <button
            onClick={() => setFocusedSpawn(null)}
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to runs
          </button>
          <LaunchPanel
            spawn={focusedSpawnEntry}
            onKill={(pid) => void killRun(pid)}
            onDismiss={(pid) => {
              setSpawns((prev) => prev.filter((x) => x.pid !== pid));
              setFocusedSpawn(null);
            }}
          />
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
          <RunList
            runs={runs}
            active={activeShown}
            spawns={spawns}
            onSelect={open}
            onOpenActive={(a) => {
              setFocusedSpawn(null);
              setLiveRun(a);
            }}
            onOpenSpawn={setFocusedSpawn}
          />
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
