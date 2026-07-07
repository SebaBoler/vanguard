import { useState } from 'react';
import { Button, Textarea } from 'chunks-ui';
import { Play } from 'lucide-react';

export function NewRunForm({
  defaultCommand,
  onRun,
  onCancel,
}: {
  defaultCommand: string;
  onRun: (command: string) => void;
  onCancel: () => void;
}) {
  const [cmd, setCmd] = useState(defaultCommand);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">
        Launch command — runs in the project dir, inherits your shell environment (credentials).
      </div>
      <Textarea
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        rows={2}
        className="w-full font-mono text-xs"
        placeholder="vanguard run --github <issue> --provider zai --llm-proxy"
      />
      <div className="flex justify-end gap-2">
        <Button variant="text" color="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => cmd.trim() && onRun(cmd.trim())} startIcon={<Play className="size-4" />}>
          Run
        </Button>
      </div>
    </div>
  );
}
