import { useEffect, useState } from 'react';
import { Button, Chip } from 'chunks-ui';
import { Minus, Plus } from 'lucide-react';
import { spawnRun, killRun, readAppConfig } from '../../ipc';
import type { ActiveRun } from '../../vanguard-output';

export function Fleet({ project, active }: { project: string; active: ActiveRun[] }) {
  const [concurrency, setConcurrency] = useState(3);
  const [loopV1, setLoopV1] = useState(false);
  const [source, setSource] = useState('github');
  const [watchPid, setWatchPid] = useState<number | null>(null);

  useEffect(() => {
    readAppConfig(project)
      .then((c) => {
        if (c.concurrency) setConcurrency(c.concurrency);
        if (c.source) setSource(c.source);
      })
      .catch(() => {});
  }, [project]);

  const running = watchPid !== null;

  const start = async (): Promise<void> => {
    const cmd = `vanguard watch --${source} --concurrency ${concurrency}${loopV1 ? ' --loop-v1' : ''} --provider zai --llm-proxy`;
    try {
      setWatchPid(await spawnRun(project, cmd));
    } catch {
      /* surfaced via the launch panel */
    }
  };
  const stop = async (): Promise<void> => {
    if (watchPid) await killRun(watchPid);
    setWatchPid(null);
  };

  const slots = Array.from({ length: concurrency }, (_, i) => active[i] ?? null);

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Fleet</h2>
        {running && (
          <Button className="ml-auto" variant="outlined" color="destructive" onClick={stop}>
            Stop all
          </Button>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-border p-5">
        <div className="flex items-center gap-2">
          <span className="font-medium">Watch Loop</span>
          <Chip color={running ? 'success' : 'secondary'} variant="outlined">
            {running ? 'running' : 'stopped'}
          </Chip>
          <button
            onClick={running ? stop : start}
            aria-label="Toggle watch loop"
            className={`relative ml-auto h-6 w-11 rounded-full transition-colors ${running ? 'bg-green-500' : 'bg-muted'}`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${running ? 'left-[22px]' : 'left-0.5'}`}
            />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          list ready Tasks → Claim → Run, autonomously, until stopped
        </p>

        <div className="flex flex-wrap items-center gap-8 border-t border-border pt-4">
          <div>
            <div className="text-sm">Concurrency</div>
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={() => setConcurrency((c) => Math.max(1, c - 1))}
                disabled={running}
                className="grid size-7 place-items-center rounded border border-border disabled:opacity-40"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="w-8 text-center tabular-nums">{concurrency}</span>
              <button
                onClick={() => setConcurrency((c) => c + 1)}
                disabled={running}
                className="grid size-7 place-items-center rounded border border-border disabled:opacity-40"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={loopV1} onChange={(e) => setLoopV1(e.target.checked)} disabled={running} />
            Loop v1 <span className="text-muted-foreground">— cheap spec-generation pass first</span>
          </label>
          <div className="ml-auto">
            <div className="text-xs text-muted-foreground">
              Slots {active.length} / {concurrency} in use
            </div>
            <div className="mt-1 h-1.5 w-40 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-green-500 transition-all"
                style={{ width: `${Math.min(100, (active.length / concurrency) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Claimed / Running</div>
      <div className="space-y-2">
        {slots.map((a, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm">
            <span className="text-xs text-muted-foreground">slot {i + 1}</span>
            {a ? (
              <>
                <span className="size-2 rounded-full bg-green-500" />
                <span className="font-mono font-medium">{a.taskId}</span>
                <Chip color="success" variant="outlined">running</Chip>
              </>
            ) : (
              <span className="text-muted-foreground">idle — polling for ready Tasks</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
