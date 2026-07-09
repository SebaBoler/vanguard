import { useEffect, useRef, useState } from 'react';
import { StreamView } from './StreamView';
import { readSession } from '../../ipc';
import type { ActiveRun, SessionRead } from '../../vanguard-output';

export function LiveRun({ active, refreshKey }: { active: ActiveRun; refreshKey: number }) {
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
        <span>{turns} turns</span>
        <span>{tools} tools</span>
        {tok > 0 && (
          <span>
            {data!.inputTokens.toLocaleString()}/{data!.outputTokens.toLocaleString()} tok
          </span>
        )}
      </div>
      <div className="max-h-[72vh] overflow-auto rounded border border-border bg-muted/30 p-4">
        <StreamView entries={entries} empty="Waiting for output…" />
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
