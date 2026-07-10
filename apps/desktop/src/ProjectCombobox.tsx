import { Combobox } from '@/ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { projectColor } from './color';
import type { Project } from './vanguard-output';

interface Item {
  value: string;
  label: string;
  color: string;
}

/** Inline project switcher for the breadcrumb (replaces the sidebar's project select). Searchable.
 * The Input is the in-flow anchor the popup positions against — keep it inside the control wrapper. */
export function ProjectCombobox({
  projects,
  active,
  onSelect,
}: {
  projects: Project[];
  active: Project;
  onSelect: (path: string) => void;
}) {
  const items: Item[] = projects.map((p) => ({ value: p.path, label: p.name, color: projectColor(p) }));
  const selected = items.find((i) => i.value === active.path) ?? null;

  return (
    <Combobox.Root
      items={items}
      value={selected}
      onValueChange={(v: Item | null) => {
        if (v) onSelect(v.value);
      }}
      itemToStringLabel={(item: Item) => item.label}
    >
      <div className="relative inline-flex items-center gap-1.5 rounded hover:bg-muted">
        <span className="ml-1.5 size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: projectColor(active) }} />
        <Combobox.Input
          placeholder="Project…"
          title={active.name}
          className="w-36 truncate bg-transparent py-0.5 pr-5 text-sm font-medium outline-none"
        />
        <Combobox.Trigger aria-label="Switch project" className="absolute right-1 text-muted-foreground">
          <ChevronsUpDown className="size-3.5" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} align="start">
          <Combobox.Popup className="z-50 max-h-72 w-60 overflow-auto rounded-md border border-border bg-background p-1 shadow-md">
            <Combobox.List>
              {(item: Item) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm data-[highlighted]:bg-muted"
                >
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <Combobox.ItemIndicator>
                    <Check className="size-4" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
            <Combobox.Empty className="px-2 py-1 text-sm text-muted-foreground">No projects</Combobox.Empty>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
