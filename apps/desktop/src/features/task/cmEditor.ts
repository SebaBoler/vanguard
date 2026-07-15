import { useSyncExternalStore } from 'react';

// System coding fonts with ligature support — nothing bundled, graceful fallback to Menlo/monospace.
export const EDITOR_FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, monospace";

// Track the app theme live: App.tsx toggles the `dark` class on <html>. We subscribe to that class
// so an editor re-themes in place while mounted (no remount).
function subscribeToClass(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}

export function useAppDark(): boolean {
  return useSyncExternalStore(subscribeToClass, () =>
    document.documentElement.classList.contains('dark'),
  );
}
