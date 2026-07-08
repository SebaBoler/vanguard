function lineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-green-600 dark:text-green-400 bg-success/10';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-red-600 dark:text-red-400 bg-destructive/10';
  if (line.startsWith('@@')) return 'text-sky-600 dark:text-sky-400';
  if (line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground font-medium';
  return 'text-foreground/80';
}

export function DiffView({ diff }: { diff?: string }) {
  if (!diff) {
    return <div className="text-sm text-muted-foreground">No diff captured.</div>;
  }
  return (
    <pre className="max-h-[32rem] overflow-auto rounded border border-border bg-muted/40 py-2 font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => (
        <div key={i} className={`px-3 ${lineClass(line)}`}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
