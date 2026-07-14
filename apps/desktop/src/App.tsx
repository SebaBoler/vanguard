import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { type Theme } from '@/ui';
import { open } from '@tauri-apps/plugin-dialog';
import { TopBar, type Crumb } from './TopBar';
import { Rail, type Screen } from './Rail';
import { CommandPalette } from './CommandPalette';
import { TailwindDebugScreens } from './components/TailwindDebugScreens';
import { Dashboard } from './features/dashboard/Dashboard';
import { Inspector } from './features/inspector/Inspector';
import { listProjects, addProject, removeProject, listActive } from './ipc';
import { projectColor, contrastColor } from './color';
import { createNavGuardRegistry, NavGuardContext } from './navGuard';
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
  // Navigation guard (S8, #339): a dirty screen registers a confirm; ALL App-owned navigation
  // routes through navigate(), because a project switch REMOUNTS Inspector (key below) and a
  // screen switch unmounts the editor — component-local confirms never fire for either.
  // Lazy init (review #343 r4 nit): useRef(create()) would re-run the factory every render and
  // discard the result — harmless here, but the idiom avoids the per-render allocation.
  const navGuardRef = useRef<ReturnType<typeof createNavGuardRegistry> | null>(null);
  navGuardRef.current ??= createNavGuardRegistry();
  const navGuard = navGuardRef as { current: ReturnType<typeof createNavGuardRegistry> };
  const navigate = (fn: () => void): void => {
    if (!navGuard.current.confirm()) return;
    fn();
  };
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

  // Window close is the third discard path. Tauri/WKWebView does not reliably fire beforeunload
  // on native close, so onCloseRequested is the primary hook (beforeunload kept as a belt).
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested((event) => {
      if (!navGuard.current.confirm()) event.preventDefault();
    });
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (navGuard.current.guarded()) {
        e.preventDefault();
        e.returnValue = ''; // some WebKit/Chromium builds need returnValue, not just preventDefault
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      void un.then((f) => f());
      window.removeEventListener('beforeunload', onBeforeUnload);
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
      /* ignore */
    }
  };

  const remove = async (path: string): Promise<void> => {
    // Removing the ACTIVE project unmounts Inspector — guard like any navigation.
    if (activeProject === path && !navGuard.current.confirm()) return;
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
    navigate(() => {
      setActiveProject(path);
      setScreen('runs');
    });
  };

  const active = projects.find((p) => p.path === activeProject) ?? null;
  const showDashboard = screen === 'dashboard' || !active;
  const titleBar = !showDashboard && active ? projectColor(active) : null;

  const SCREEN_LABEL: Record<Screen, string> = {
    dashboard: 'Home',
    runs: 'Runs',
    board: 'Task board',
    docs: 'Docs',
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
      <ProjectCombobox projects={projects} active={active} onSelect={(path) => navigate(() => setActiveProject(path))} />
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
        onHome={() => navigate(() => setScreen('dashboard'))}
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
            onScreen={(sc) => navigate(() => setScreen(sc))}
            onOpenRunning={(r) => {
              // The sixth navigation path (review round 1) — also discards a dirty editor.
              navigate(() => {
                setScreen('runs');
                setFocusRunning(r);
              });
            }}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {showDashboard ? (
            <Dashboard
              projects={projects}
              onOpen={(p) => enterProject(p.path)}
              onAdd={add}
              onRemove={remove}
            />
          ) : (
            <NavGuardContext.Provider value={navGuard.current}>
              <Inspector
                key={active.path}
                project={active.path}
                screen={screen}
                focusRunning={focusRunning}
                clearNonce={clearNonce}
                onCrumb={setCrumb}
              />
            </NavGuardContext.Provider>
          )}
        </main>
      </div>
      {palette && (
        <CommandPalette
          projects={projects}
          onOpenProject={(p) => enterProject(p.path)}
          onHome={() => navigate(() => setScreen('dashboard'))}
          onAddProject={add}
          onToggleTheme={toggleTheme}
          onClose={() => setPalette(false)}
        />
      )}
      <TailwindDebugScreens />
    </div>
  );
}
