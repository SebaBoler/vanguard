import { useEffect, useRef, useState } from 'react';
import { Button, Chip, cn } from '@/ui';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Play, RefreshCw } from 'lucide-react';
import {
  listRuns,
  listActive,
  readRun,
  watchProject,
  unwatchProject,
  apiCapabilitiesCached,
  apiCreateRun,
  apiActiveRun,
  apiRunBacklog,
  apiCancel,
  apiRepoOk,
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
import { DocsScreen } from '../docs/DocsScreen';
import { NewRunForm } from './NewRunForm';
import { RunStrip } from './RunStrip';
import { reduceTypedRun, initialTypedRun, type TypedRunState, type RunEvent } from './typedRunReducer';
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
  screen: 'runs' | 'board' | 'docs' | 'fleet' | 'remote' | 'workflow' | 'settings';
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
  const [showNewRun, setShowNewRun] = useState(false);
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);
  // Typed run (S1): capabilities for the form, the single in-flight typed run, and the idle-check.
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [typedRun, setTypedRun] = useState<TypedRunState | null>(null);
  const [checkedIdle, setCheckedIdle] = useState(false); // false until apiActiveRun() resolves on mount
  const [foreignRun, setForeignRun] = useState<string | null>(null); // repoPath of another project's live run (S8)
  const typedRunRef = useRef<TypedRunState | null>(null); // latest typedRun, readable in async callbacks
  const dismissedRunId = useRef<string | null>(null); // a run the user closed — ignore its late events
  const runGen = useRef(0); // bumped per launch; a settled apiCreateRun from an older run is dropped
  const [repoOk, setRepoOk] = useState(true); // cached: is `project` a git work tree? (fails a run at click)

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

  // Load the capability surface once (cached; pure — never blocks on a live run).
  useEffect(() => {
    void apiCapabilitiesCached().then(setCaps).catch(() => setCaps(null));
  }, []);

  // Cached repo pre-flight per project (Inspector is key={project}, so this runs once per project).
  useEffect(() => {
    void apiRepoOk(project).then(setRepoOk).catch(() => setRepoOk(true)); // couldn't verify → don't block
  }, [project]);

  // Mirror typedRun into a ref so async callbacks (the apiCreateRun catch) can read the latest value.
  useEffect(() => {
    typedRunRef.current = typedRun;
  }, [typedRun]);

  // Subscribe to the typed-run event stream and fold into `typedRun` (reducer drops foreign runIds).
  // Ignore events for a run the user has dismissed, so a late event can't resurrect a closed strip.
  useEffect(() => {
    const un = listen<{ runId: string; event: RunEvent }>('api:event', (e) => {
      if (e.payload.runId === dismissedRunId.current) return;
      // repoPath scopes adoption: a foreign project's run can never seed a strip here (S8).
      setTypedRun((prev) => reduceTypedRun(prev ?? initialTypedRun(), e.payload, project));
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
    const attach = async (): Promise<void> => {
      try {
        const active = await apiActiveRun();
        if (active === null) return;
        if (active.repoPath !== project) {
          // Another project's run holds the sidecar. Don't fold its backlog — surface a note
          // instead; New-run stays enabled (the Rust single-in-flight guard rejects with a clear
          // error, which beats silently disabling the button for a run the user can't see).
          setForeignRun(active.repoPath);
          return;
        }
        const backlog = (await apiRunBacklog(active.runId)) as { runId: string; event: RunEvent }[];
        // Fold BEFORE flipping checkedIdle: between the two the button's guard would see
        // checkedIdle && typedRun === null and enable New run while a run is genuinely live.
        setTypedRun((prev) =>
          backlog.reduce((s, p) => reduceTypedRun(s, p, project), prev ?? initialTypedRun()),
        );
      } catch {
        // Treat an unverifiable idle-check as idle: a rejected apiActiveRun (sidecar not up yet, IPC
        // error) must not leave the New-run button disabled forever. The Rust busy guard still
        // rejects a second concurrent run, so the worst case is a confusing error, not corruption.
      } finally {
        setCheckedIdle(true);
      }
    };
    void attach();
  }, []);

  const startTypedRun = (params: CreateRunParams): void => {
    // Guard the launch itself, not just the toolbar button — the form has a second entry point
    // (board → TaskDetail → New Run) that isn't screen-gated, so a click there could clobber the
    // in-flight run's client state. The ref is synced for a run that's been live a moment.
    //
    // checkedIdle is part of the guard, not just the button's disabled state: during mount re-attach
    // a run can be live in the sidecar while typedRunRef is still null, and a board-path launch in
    // that window would set a fresh strip, get rejected by the Rust busy guard, and wipe the strip
    // the re-attach effect is concurrently folding the backlog into.
    if (!checkedIdle) return;
    if (typedRunRef.current !== null && typedRunRef.current.terminal === undefined) return;
    if (!repoOk) {
      setError(`${project} is not a git work tree — cannot run here.`);
      return;
    }
    setShowNewRun(false);
    setError(null);
    // Dismiss the outgoing terminal run: the fresh state has no runId yet, so a late buffered event
    // from the previous run would otherwise be ADOPTED as this run's identity (`state.runId ?? payload.runId`)
    // and the new run's own run-accepted then dropped as foreign.
    dismissedRunId.current = typedRunRef.current?.runId ?? null;
    // Tie both continuations below to THIS launch. Without it they read current state: run A settling
    // after run B started would let A's catch wipe B's strip, or A's terminal land on B.
    const gen = ++runGen.current;
    const started = initialTypedRun();
    typedRunRef.current = started; // sync in-flight marker (the effect-synced ref lags a render)
    setTypedRun(started); // "starting…" — "run live" derives from this
    setDetail(null);
    setLiveRun(null);
    void apiCreateRun(params)
      .then((res) => {
        if (runGen.current !== gen) return; // a newer run owns the strip
        // The event stream owns the terminal; this is a backstop only if the terminal event was lost —
        // write it ONLY when still non-terminal. Precedence matches the reducer (prUrl → secretBlocked).
        // NOTE: the spec (Part 3, G6) says the reducer alone owns terminal and the promise must never
        // write it. This is a deliberate deviation: the `terminal === undefined` guard neutralizes the
        // double-badge race the spec warned about, and without the backstop a lost run-end would spin
        // the strip forever.
        setTypedRun((prev) =>
          prev !== null && prev.terminal === undefined
            ? { ...prev, terminal: res.prUrl !== undefined ? { kind: 'success', prUrl: res.prUrl } : res.secretBlocked === true ? { kind: 'secret-blocked' } : { kind: 'no-changes' } }
            : prev,
        );
      })
      .catch((e) => {
        if (runGen.current !== gen) return; // a newer run owns the strip
        // apiCreateRun rejects on BOTH a pre-start rejection (the Rust single-in-flight guard, which
        // returns Err before any run-accepted event) AND a run that started then errored/cancelled
        // (resolve_terminal returns Err for those). Only the former needs clearing + a banner — it never
        // adopted a runId. A real error/cancel already folded run-accepted, so its runId is set and the
        // terminal EVENT renders it in the strip; don't wipe it or double-report.
        //
        // Asymmetry with .then above, on purpose: this path does NOT synthesize a terminal backstop. A
        // lost run-error/run-cancelled would spin the strip forever, and we lean on the S0.5 guarantee
        // that Rust buffers a terminal on every in-session path rather than guessing one here.
        if (typedRunRef.current?.runId === undefined) {
          setError(String(e));
          setTypedRun(null);
        }
      });
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
    <div
      className={cn(
        'mx-auto flex h-full w-full min-h-0 flex-col gap-4 p-6',
        screen !== 'board' && screen !== 'docs' && 'max-w-5xl',
      )}
    >
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

      {foreignRun !== null && typedRun === null && screen === 'runs' && (
        <div className="mb-2 rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          a run is live in <code className="font-mono">{foreignRun}</code> — starting one here will be rejected until it finishes
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
          <WorkflowEditor project={project} />
        </div>
      ) : screen === 'settings' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Settings project={project} />
        </div>
      ) : screen === 'docs' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <DocsScreen project={project} />
        </div>
      ) : null}
    </div>
  );
}
