import { Card, Chip } from '@/ui';
import type { Proof } from '../../vanguard-output';

export function ProofGate({ proof }: { proof?: Proof }) {
  if (!proof) {
    return <div className="text-sm text-muted-foreground">No proof-of-work recorded.</div>;
  }
  const ok = proof.passed;
  return (
    <Card.Root className={ok ? undefined : 'border-destructive/40'}>
      <Card.Header className="flex flex-row items-center justify-between gap-2 pb-3">
        <Card.Title className="text-base">Proof of work</Card.Title>
        <Chip color={ok ? 'success' : 'destructive'}>{ok ? 'passed' : 'failed'}</Chip>
      </Card.Header>
      <Card.Content className="pt-0">
        <div className="text-sm text-muted-foreground">
          <code className="rounded bg-muted px-1 py-0.5">{proof.command}</code> · exit {proof.exitCode}
        </div>
        <pre
          className={`mt-3 max-h-64 overflow-auto rounded bg-muted p-3 text-xs ${ok ? '' : 'text-destructive'}`}
        >
          {proof.outputTail}
        </pre>
      </Card.Content>
    </Card.Root>
  );
}
