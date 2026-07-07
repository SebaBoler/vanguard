import { useEffect, useRef, useState } from 'react';
import { Button } from 'chunks-ui';
import { ArrowLeft } from 'lucide-react';
import { readSession } from '../../ipc';
import type { ActiveRun, TranscriptEntry } from '../../vanguard-output';

export function LiveRun({
  active,
  refreshKey,
  onBack,
}: {
  active: ActiveRun;
  refreshKey: number;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    readSession(active.sessionFile)
      .then((e) => {
        if (alive) setEntries(e);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active.sessionFile, refreshKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="text" color="secondary" onClick={onBack} startIcon={<ArrowLeft className="size-4" />}>
          Runs
        </Button>
        <h2 className="font-semibold">{active.taskId}</h2>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-green-500" />
          running
        </span>
      </div>
      <div className="max-h-[70vh] space-y-2 overflow-auto rounded border border-border bg-muted/40 p-3">
        {entries.length === 0 ? (
          <div className="text-sm text-muted-foreground">Waiting for output…</div>
        ) : (
          entries.map((e, i) =>
            e.role === 'tool' ? (
              <div key={i} className="font-mono text-xs text-muted-foreground">
                → {e.text}
              </div>
            ) : (
              <p key={i} className="whitespace-pre-wrap text-sm">
                {e.text}
              </p>
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
