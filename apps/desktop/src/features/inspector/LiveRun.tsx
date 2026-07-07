import { useEffect, useRef, useState } from 'react';
import { StreamView } from './StreamView';
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
    <div className="max-h-[72vh] overflow-auto rounded border border-border bg-muted/30 p-4">
      <StreamView entries={entries} empty="Waiting for output…" />
      <div ref={bottomRef} />
    </div>
  );
}
