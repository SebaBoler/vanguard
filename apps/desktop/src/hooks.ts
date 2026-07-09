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

/** Load a project's AppConfig into editable local state; reloads when the project changes. */
export function useAppConfig(project: string): [AppConfig, Dispatch<SetStateAction<AppConfig>>] {
  const [cfg, setCfg] = useState<AppConfig>({});
  useEffect(() => {
    readAppConfig(project).then(setCfg).catch(() => {});
  }, [project]);
  return [cfg, setCfg];
}
