// The single UI seam for the desktop app. Everything visual is imported from `@/ui`, never from
// `chunks-ui` directly — so the underlying kit can be swapped here in one place. Re-exports are
// additive and deliberate: only the chunks-ui components the app actually uses are surfaced here,
// so this file doubles as the app's UI inventory. Add a line when a screen first needs a component.

export type { Theme } from 'chunks-ui';
export {
  Breadcrumb,
  Button,
  Card,
  Chip,
  Collapsible,
  Combobox,
  cn,
  Empty,
  Input,
  Select,
  Table,
  Tabs,
  Textarea,
  ThemeToggle,
  Tooltip,
} from 'chunks-ui';
export { Callout } from './Callout';
export { CodeBlock } from './CodeBlock';
export { Logo } from './Logo';
// The app's own presentational components, alongside the kit re-exports above.
export { Markdown } from './Markdown';
export { ScrollTable } from './ScrollTable';
