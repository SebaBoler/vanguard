import { AgentText } from '../../components/AgentText';

type Entry = { role: string; text: string };

/** Shared renderer for agent streams (live session + completed transcript). */
export function StreamView({ entries, empty = 'No output.' }: { entries: Entry[]; empty?: string }) {
  if (entries.length === 0) {
    return <div className="text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <div className="space-y-3">
      {entries.map((e, i) => {
        if (e.role === 'assistant') return <AgentText key={i}>{e.text}</AgentText>;
        if (e.role === 'tool') {
          return (
            <div key={i} className="font-mono text-xs text-sky-600 dark:text-sky-400">
              → {e.text}
            </div>
          );
        }
        if (e.role === 'tool_result') {
          return (
            <div key={i} className="truncate font-mono text-xs text-muted-foreground">
              ← {e.text}
            </div>
          );
        }
        return (
          <div key={i} className="text-xs font-medium text-muted-foreground">
            ✓ {e.text}
          </div>
        );
      })}
    </div>
  );
}
