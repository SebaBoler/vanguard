import { Select } from '@/ui';
import { ChevronsUpDown } from 'lucide-react';

/** Thin wrapper over the base-ui Select compound for a fixed enum field (transport/provider/flow). */
export function EnumSelect({
  value,
  onValueChange,
  options,
  placeholder,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => v !== null && onValueChange(v)}>
      <Select.Trigger className="flex min-w-32 items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-xs">
        <Select.Value placeholder={placeholder ?? 'Select…'} />
        <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup className="rounded border border-border bg-popover p-1 text-xs shadow-md">
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="cursor-pointer rounded px-2 py-1 hover:bg-muted data-[selected]:bg-muted"
              >
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
