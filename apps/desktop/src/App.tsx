import { useEffect, useState } from 'react';
import { type Theme } from 'chunks-ui';
import { open } from '@tauri-apps/plugin-dialog';
import { TopBar, type Crumb } from './TopBar';
import { Rail, type Screen } from './Rail';
import { CommandPalette } from './CommandPalette';
import { TailwindDebugScreens } from './components/TailwindDebugScreens';
import { Dashboard } from './features/dashboard/Dashboard';
import { Inspector } from './features/inspector/Inspector';
import { listProjects, addProject, removeProject, listActive } from './ipc';
import { projectColor, contrastColor } from './color';
import { ProjectCombobox } from './ProjectCombobox';
import type { Project, ActiveRun } from './vanguard-output';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [railRunning, setRailRunning] = useState<ActiveRun[]>([]);
  const [focusRunning, setFocusRunning] = useState<ActiveRun | null>(null);
  const [crumb, setCrumb] = useState<string | null>(null);
  const [clearNonce, setClearNonce] = useState(0);
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

  // Default the current project to the first once projects load.
  useEffect(() => {
    if (!activeProject && projects.length) setActiveProject(projects[0].path);
  }, [projects, activeProject]);

  // Poll the current project's in-flight runs for the rail's Running section.
  useEffect(() => {
    if (!activeProject) {
      setRailRunning([]);
      return;
    }
    let alive = true;
    const tick = (): void => {
      listActive(activeProject)
        .then((a) => {
          if (alive) setRailRunning(a);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeProject]);

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
      /* ignore */
    }
  };

  const remove = async (path: string): Promise<void> => {
    try {
      setProjects(await removeProject(path));
      if (activeProject === path) setActiveProject(null);
    } catch {
      /* ignore */
    }
  };

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    localStorage.setItem('vg-theme', next);
  };

  const enterProject = (path: string): void => {
    setActiveProject(path);
    setScreen('runs');
  };

  const active = projects.find((p) => p.path === activeProject) ?? null;
  const showDashboard = screen === 'dashboard' || !active;
  const titleBar = !showDashboard && active ? projectColor(active) : null;

  const SCREEN_LABEL: Record<Screen, string> = {
    dashboard: 'Home',
    runs: 'Runs',
    board: 'Task board',
    fleet: 'Fleet',
    remote: 'Remote',
    workflow: 'Workflow',
    settings: 'Settings',
  };
  // Home lives on the logo now; the project lives in the switcher — so the breadcrumb is just the screen.
  const crumbs: Crumb[] = [];
  if (active && screen !== 'dashboard') {
    if (crumb) {
      crumbs.push({ label: SCREEN_LABEL[screen], onClick: () => setClearNonce((n) => n + 1) });
      crumbs.push({ label: crumb });
    } else {
      crumbs.push({ label: SCREEN_LABEL[screen] });
    }
  }
  const projectSwitcher =
    active && screen !== 'dashboard' ? (
      <ProjectCombobox projects={projects} active={active} onSelect={(path) => setActiveProject(path)} />
    ) : null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Custom titlebar (native decorations overlaid, macOS): the app/project identity. In a project
          it takes that project's color so the working context is unmistakable; generic on the dashboard. */}
      <div
        data-tauri-drag-region
        className="flex h-8 shrink-0 select-none items-center pl-20 pr-4 text-[13px] font-semibold text-foreground"
        style={titleBar ? { backgroundColor: titleBar, color: contrastColor(titleBar) } : undefined}
      >
        Vanguard Inspector
      </div>
      <TopBar
        crumbs={crumbs}
        projectSwitcher={projectSwitcher}
        onHome={() => setScreen('dashboard')}
        onCommandK={() => setPalette(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="flex min-h-0 flex-1">
        {/* The rail is project-context navigation; the dashboard is generic and stays sidebar-less. */}
        {!showDashboard && (
          <Rail
            projects={projects}
            activePath={activeProject}
            screen={screen}
            running={railRunning}
            onScreen={setScreen}
            onOpenRunning={(r) => {
              setScreen('runs');
              setFocusRunning(r);
            }}
          />
        )}
        <main className="min-w-0 flex-1 overflow-auto p-6">
          {showDashboard ? (
            <Dashboard
              projects={projects}
              onOpen={(p) => enterProject(p.path)}
              onAdd={add}
              onRemove={remove}
            />
          ) : (
            <Inspector
              key={active.path}
              project={active.path}
              screen={screen}
              focusRunning={focusRunning}
              clearNonce={clearNonce}
              onCrumb={setCrumb}
            />
          )}
        </main>
      </div>
      {palette && (
        <CommandPalette
          projects={projects}
          onOpenProject={(p) => enterProject(p.path)}
          onHome={() => setScreen('dashboard')}
          onAddProject={add}
          onToggleTheme={toggleTheme}
          onClose={() => setPalette(false)}
        />
      )}
      <TailwindDebugScreens />
    </div>
  );
}
