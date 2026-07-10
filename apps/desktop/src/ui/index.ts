// The single UI seam for the desktop app. Everything visual is imported from `@/ui`, never from
// `chunks-ui` directly — so the underlying kit can be swapped here in one place. Re-exports the whole
// chunks-ui surface plus the app's own presentational components.
export * from 'chunks-ui';

export { Markdown } from './Markdown';
export { CodeBlock } from './CodeBlock';
export { Callout } from './Callout';
export { ScrollTable } from './ScrollTable';
export { Logo } from './Logo';
