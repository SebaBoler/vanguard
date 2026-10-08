import type { ReactNode } from 'react';

/**
 * Wrap a chunks-ui `<Table.Root>` so its ROWS scroll while a `sticky top-0` `<Table.Header>` stays
 * pinned. chunks-ui's `Table.Root` injects an un-classable `overflow-x-auto` wrapper `<div>` around
 * the `<table>`; the `[&>div]` variants target THAT wrapper to make it the bounded scroll container,
 * so the sticky thead has a scroll ancestor to stick to.
 * ponytail: depends on Table.Root rendering exactly one wrapper `<div>` — degrades to a non-sticky
 * header (rows still scroll) if chunks-ui changes that internal structure. Pair with
 * `<Table.Header className="sticky top-0 z-10 bg-muted">`.
 */
export function ScrollTable({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden [&>div]:h-full [&>div]:overflow-y-auto">{children}</div>
  );
}
