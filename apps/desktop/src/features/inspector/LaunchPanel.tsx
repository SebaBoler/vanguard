import { useEffect, useRef } from 'react';
import { Button, Chip } from '@/ui';
import { Square, X } from 'lucide-react';

export interface Spawn {
  pid: number;
  command: string;
  lines: string[];
  exit?: number | null;
}

export function LaunchPanel({
  spawn,
  onKill,
  onDismiss,
}: {
  spawn: Spawn;
  onKill: (pid: number) => void;
  onDismiss: (pid: number) => void;
}) {
  const running = spawn.exit === undefined;
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [spawn.lines.length]);

  return (
    <div className="rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {running ? (
          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <span className="size-2 animate-pulse rounded-full bg-success" />
            running
          </span>
        ) : (
          <Chip color={spawn.exit === 0 ? 'success' : 'destructive'} variant="outlined">
            exit {spawn.exit ?? '?'}
          </Chip>
        )}
        <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={spawn.command}>
          {spawn.command}
        </code>
        {running ? (
          <Button variant="text" color="destructive" onClick={() => onKill(spawn.pid)} startIcon={<Square className="size-3.5" />}>
            Kill
          </Button>
        ) : (
          <button onClick={() => onDismiss(spawn.pid)} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>
      {spawn.lines.length > 0 && (
        <div className="max-h-56 overflow-auto p-3">
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
            {spawn.lines.slice(-400).join('\n')}
          </pre>
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
