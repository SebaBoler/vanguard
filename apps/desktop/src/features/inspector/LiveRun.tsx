import { useEffect, useRef, useState } from 'react';
import { StreamView } from './StreamView';
import { readSession } from '../../ipc';
import { cn } from '@/ui';
import type { ActiveRun, SessionRead } from '../../vanguard-output';

export function LiveRun({
  active,
  refreshKey,
  budgetUsd,
}: {
  active: ActiveRun;
  refreshKey: number;
  /** Budget cap from the project's .vanguard/app.json; when set, the strip shows spend vs cap. */
  budgetUsd?: number;
}) {
  const [data, setData] = useState<SessionRead | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    readSession(active.sessionFile)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active.sessionFile, refreshKey]);

  const entries = data?.entries ?? [];
  const turns = entries.filter((e) => e.role === 'assistant').length;
  const tools = entries.filter((e) => e.role === 'tool').length;
  const tok = data ? data.inputTokens + data.outputTokens : 0;
  const cost = data?.estCostUsd ?? 0;
  const cap = budgetUsd && budgetUsd > 0 ? budgetUsd : null;
  const pct = cap ? Math.min(100, (cost / cap) * 100) : null;
  const over = cap != null && cost > cap;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span
          className="font-medium text-foreground"
          title="Estimated spend so far — priced live from token usage; a lower bound (unpriced models excluded)"
        >
          ~${cost.toFixed(2)}
        </span>
        {cap != null && (
          <span
            className={cn('flex items-center gap-1.5', over && 'font-medium text-destructive')}
            title={`Budget cap $${cap.toFixed(2)} (from .vanguard/app.json)`}
          >
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full', over ? 'bg-destructive' : pct! >= 75 ? 'bg-amber-500' : 'bg-success')}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span>
              ${cost.toFixed(2)} / ${cap.toFixed(2)}
            </span>
          </span>
        )}
        <span className="text-border">·</span>
        <span>{turns} turns</span>
        <span>{tools} tools</span>
        {tok > 0 && (
          <span>
            {data!.inputTokens.toLocaleString()}/{data!.outputTokens.toLocaleString()} tok
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-muted/30 p-4">
        <StreamView entries={entries} empty="Waiting for output…" />
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
