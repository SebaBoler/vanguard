export function DiffView({ diff }: { diff?: string }) {
  if (!diff) {
    return <div className="text-sm text-muted-foreground">No diff captured.</div>;
  }
  return (
    <pre className="max-h-[28rem] overflow-auto rounded border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
      {diff}
    </pre>
  );
}
