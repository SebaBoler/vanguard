import type { Proof } from '../../vanguard-output';

export function ProofGate({ proof }: { proof?: Proof }) {
  if (!proof) {
    return <div className="text-sm opacity-60">No proof-of-work recorded.</div>;
  }
  const ok = proof.passed;
  return (
    <div className={`pl-3 border-l-4 ${ok ? 'border-green-500' : 'border-red-500'}`}>
      <div className="font-semibold">Proof of work: {ok ? 'PASS' : 'FAIL'}</div>
      <div className="text-sm">
        command: <code>{proof.command}</code> · exit {proof.exitCode}
      </div>
      <pre className={`mt-2 text-xs whitespace-pre-wrap ${ok ? '' : 'text-red-600'}`}>
        {proof.outputTail}
      </pre>
    </div>
  );
}
