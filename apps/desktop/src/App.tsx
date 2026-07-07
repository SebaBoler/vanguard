import { useEffect, useState } from 'react';
import { type Theme } from 'chunks-ui';
import { open } from '@tauri-apps/plugin-dialog';
import { Rail } from './Rail';
import { CommandPalette } from './CommandPalette';
import { Dashboard } from './features/dashboard/Dashboard';
import { Inspector } from './features/inspector/Inspector';
import { listProjects, addProject, removeProject } from './ipc';
import type { Project } from './vanguard-output';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<{ path: string; name: string } | null>(null);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('vg-theme');
    const initial: Theme =
      saved === 'dark' || saved === 'light'
        ? saved
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    applyTheme(initial);
    return initial;
  });

  // Poll projects so rail running-dots + dashboard metrics stay live.
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      listProjects()
        .then((p) => {
          if (alive) setProjects(p);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const add = async (): Promise<void> => {
    try {
      const dir = await open({ directory: true, title: 'Add a repo (contains .vanguard/)' });
      if (typeof dir === 'string') setProjects(await addProject(dir));
    } catch {
      // ignore dialog/add errors
    }
  };

  const remove = async (path: string): Promise<void> => {
    try {
      setProjects(await removeProject(path));
      setActive((a) => (a?.path === path ? null : a));
    } catch {
      // ignore
    }
  };

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    localStorage.setItem('vg-theme', next);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Rail
        projects={projects}
        activePath={active?.path ?? null}
        onSelect={setActive}
        onHome={() => setActive(null)}
        onAdd={add}
        onCommandK={() => setPalette(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main className="flex-1 overflow-auto p-6">
        {active ? (
          <Inspector key={active.path} project={active.path} name={active.name} onExit={() => setActive(null)} />
        ) : (
          <Dashboard projects={projects} onOpen={setActive} onAdd={add} onRemove={remove} />
        )}
      </main>
      {palette && (
        <CommandPalette
          projects={projects}
          onOpenProject={setActive}
          onHome={() => setActive(null)}
          onAddProject={add}
          onToggleTheme={toggleTheme}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}
