import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { readSession } from '../../ipc';
import type { ActiveRun, TranscriptEntry } from '../../vanguard-output';

export function LiveRun({ active, refreshKey }: { active: ActiveRun; refreshKey: number }) {
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
    <div className="max-h-[72vh] space-y-3 overflow-auto rounded border border-border bg-muted/30 p-4">
      {entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">Waiting for output…</div>
      ) : (
        entries.map((e, i) =>
          e.role === 'tool' ? (
            <div key={i} className="font-mono text-xs text-muted-foreground">→ {e.text}</div>
          ) : (
            <Markdown key={i}>{e.text}</Markdown>
          ),
        )
      )}
      <div ref={bottomRef} />
    </div>
  );
}
