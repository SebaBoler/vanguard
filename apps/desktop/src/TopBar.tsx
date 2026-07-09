import { Fragment } from 'react';
import { Breadcrumb, Chip, ThemeToggle, type Theme } from 'chunks-ui';
import { Search } from 'lucide-react';
import { Logo } from './Logo';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function TopBar({
  crumbs,
  onCommandK,
  theme,
  onToggleTheme,
}: {
  crumbs: Crumb[];
  onCommandK: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <Logo className="size-5 text-primary" />
      <span className="font-semibold">Vanguard</span>
      <Chip color="secondary" variant="outlined">Inspector</Chip>
      <span className="text-border">|</span>
      <Breadcrumb.Root>
        <Breadcrumb.List>
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <Breadcrumb.Separator />}
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
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onCommandK}
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
