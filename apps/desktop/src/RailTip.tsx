import { type ReactElement } from 'react';
import { Tooltip } from '@/ui';

/** Collapsed the rail is icon-only, so a label survives as a right-side tooltip; expanded, the label is
 * visible and the trigger renders bare. One `render`-composed element serves both states. */
export function RailTip({
  collapsed,
  label,
  children,
}: {
  collapsed: boolean;
  label: string;
  children: ReactElement;
}) {
  if (!collapsed) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" sideOffset={8}>
          <Tooltip.Popup className="z-50 text-foreground rounded-md border border-border bg-background px-2 py-1 text-xs shadow-md">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
