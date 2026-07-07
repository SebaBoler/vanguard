export function TranscriptView({ transcript }: { transcript?: string }) {
  if (!transcript) {
    return <div className="text-sm text-muted-foreground">No transcript.</div>;
  }
  return (
    <pre className="max-h-[28rem] w-full overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
      {transcript}
    </pre>
  );
}
