import { useMemo, useState } from 'react';
import { Button } from 'chunks-ui';
import { parseAgentStream } from './parseStream';
import { StreamView } from './StreamView';

export function TranscriptView({ transcript }: { transcript?: string }) {
  const [raw, setRaw] = useState(false);
  const entries = useMemo(() => (transcript ? parseAgentStream(transcript) : []), [transcript]);

  if (!transcript) {
    return <div className="text-sm text-muted-foreground">No transcript.</div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button variant="text" color="secondary" onClick={() => setRaw((r) => !r)}>
          {raw ? 'Formatted' : 'Show raw'}
        </Button>
      </div>
      {raw ? (
        <pre className="max-h-[32rem] w-full overflow-auto whitespace-pre-wrap rounded border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
          {transcript}
        </pre>
      ) : (
        <div className="max-h-[32rem] overflow-auto rounded border border-border bg-muted/30 p-4">
          <StreamView entries={entries} empty="No parseable transcript." />
        </div>
      )}
    </div>
  );
}
