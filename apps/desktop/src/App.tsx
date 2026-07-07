import { useState } from 'react';
import { listRuns, readRun } from './ipc';
import { RunList } from './features/inspector/RunList';
import { RunDetail } from './features/inspector/RunDetail';
import type { RunSummary, RunDetail as RunDetailT } from './vanguard-output';

export default function App() {
  const [repoPath, setRepoPath] = useState('.');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setDetail(null);
    try {
      setRuns(await listRuns(repoPath));
    } catch (e) {
      setError(String(e));
    }
  };

  const open = async (r: RunSummary) => {
    setError(null);
    try {
      setDetail(await readRun(repoPath, r.taskId, r.timestamp));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-3 text-xl font-bold">Vanguard Desktop — Inspector</h1>
      <div className="mb-4 flex gap-2">
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="repo path (contains .vanguard/)"
          className="flex-1 border px-2 py-1"
        />
        <button onClick={load} className="border px-3 py-1">
          Load
        </button>
      </div>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
      {detail ? (
        <RunDetail detail={detail} onBack={() => setDetail(null)} />
      ) : (
        <RunList runs={runs} onSelect={open} />
      )}
    </main>
  );
}
