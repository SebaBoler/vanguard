import { useEffect, useState } from 'react';

const IS_DEV = import.meta.env.DEV;

/** Dev-only overlay: viewport WxH readout (bottom-right) plus the Tailwind breakpoint
 *  badge (top-right, drawn by the `debug-screens` plugin). Renders nothing in production. */
export function TailwindDebugScreens() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (IS_DEV && !document.body.classList.contains('debug-screens')) {
      document.body.classList.add('debug-screens');
    }
  }, []);

  useEffect(() => {
    if (!IS_DEV) return;
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!IS_DEV || !size) return null;

  return (
    <div className="fixed bottom-0 right-0 z-50 bg-background px-4 py-2 text-[10px] text-foreground">
      {size.width}x{size.height}
    </div>
  );
}
