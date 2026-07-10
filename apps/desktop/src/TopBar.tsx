import { Fragment, type ReactNode } from 'react';
import { Breadcrumb, ThemeToggle, type Theme } from 'chunks-ui';
import { Search } from 'lucide-react';
import { Logo } from './Logo';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function TopBar({
  crumbs,
  projectSwitcher,
  onHome,
  onCommandK,
  theme,
  onToggleTheme,
}: {
  crumbs: Crumb[];
  /** Inline project switcher rendered as the first breadcrumb (null on the dashboard). */
  projectSwitcher?: ReactNode;
  onHome: () => void;
  onCommandK: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      {/* Logo + wordmark is the home affordance — clicking returns to the dashboard. */}
      <button
        onClick={onHome}
        className="flex items-center gap-2 rounded transition-colors hover:opacity-80"
        aria-label="Vanguard — home"
        title="Back to dashboard"
      >
        <Logo className="size-5 text-primary" />
        <span className="font-semibold">Vanguard</span>
      </button>
      {(projectSwitcher || crumbs.length > 0) && (
        <>
          <span className="text-border">|</span>
          <Breadcrumb.Root>
            <Breadcrumb.List>
              {projectSwitcher && <Breadcrumb.Item>{projectSwitcher}</Breadcrumb.Item>}
              {crumbs.map((c, i) => (
                <Fragment key={i}>
                  {(i > 0 || projectSwitcher) && <Breadcrumb.Separator />}
                  <Breadcrumb.Item>
                    {c.onClick && i < crumbs.length - 1 ? (
                      <Breadcrumb.Link onClick={c.onClick} className="cursor-pointer">
                        {c.label}
                      </Breadcrumb.Link>
                    ) : (
                      <Breadcrumb.Page>{c.label}</Breadcrumb.Page>
                    )}
                  </Breadcrumb.Item>
                </Fragment>
              ))}
            </Breadcrumb.List>
          </Breadcrumb.Root>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onCommandK}
          aria-label="Search / command palette"
          className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          <Search className="size-3.5" />
          <span className="font-mono">⌘K</span>
        </button>
        <ThemeToggle theme={theme} onClick={onToggleTheme} />
      </div>
    </header>
  );
}
