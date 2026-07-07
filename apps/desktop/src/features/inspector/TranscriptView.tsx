export function TranscriptView({ transcript }: { transcript?: string }) {
  if (!transcript) {
    return <div className="text-sm opacity-60">No transcript.</div>;
  }
  return <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{transcript}</pre>;
}
