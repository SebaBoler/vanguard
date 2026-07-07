export function DiffView({ diff }: { diff?: string }) {
  if (!diff) {
    return <div className="text-sm opacity-60">No diff captured.</div>;
  }
  return <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{diff}</pre>;
}
