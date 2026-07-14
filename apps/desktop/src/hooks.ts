import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { readAppConfig } from './ipc';
import type { AppConfig } from './vanguard-output';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Run an async fn on mount and whenever deps change, with the standard alive-guard + {data,error,loading}. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null, loading: true });
    fn()
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((e) => {
        if (alive) setState({ data: null, error: String(e), loading: false });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/**
 * Load a project's AppConfig into editable local state; reloads when the project changes.
 * `status` (S6 guard a/b): consumers that WRITE the config (Settings) must gate Save on 'ready' —
 * a save while 'loading' would write the {} seed over the file, and 'error' means the file exists
 * but does not parse (Rust read_strict), where a save would replace the user's hand-edited JSON.
 * Read-only consumers may ignore it (they just see defaults).
 */
export function useAppConfig(
  project: string,
): [AppConfig, Dispatch<SetStateAction<AppConfig>>, 'loading' | 'ready' | 'error'] {
  const [cfg, setCfg] = useState<AppConfig>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    setStatus('loading');
    readAppConfig(project)
      .then((c) => {
        if (!live) return;
        setCfg(c);
        setStatus('ready');
      })
      .catch(() => {
        if (live) setStatus('error');
      });
    return () => {
      live = false;
    };
  }, [project]);
  return [cfg, setCfg, status];
}
