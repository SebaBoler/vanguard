import { useState } from 'react';
import { Chip, ThemeToggle, type Theme } from 'chunks-ui';
import { Dashboard } from './features/dashboard/Dashboard';
import { Inspector } from './features/inspector/Inspector';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export default function App() {
  const [active, setActive] = useState<{ path: string; name: string } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const initial: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(initial);
    return initial;
  });

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-2.5 backdrop-blur">
        <span className="font-semibold">Vanguard</span>
        <Chip color="secondary" variant="outlined">Inspector</Chip>
        <div className="ml-auto">
          <ThemeToggle theme={theme} onClick={toggleTheme} />
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-4">
        {active ? (
          <Inspector project={active.path} name={active.name} onExit={() => setActive(null)} />
        ) : (
          <Dashboard onOpen={setActive} />
        )}
      </main>
    </div>
  );
}
