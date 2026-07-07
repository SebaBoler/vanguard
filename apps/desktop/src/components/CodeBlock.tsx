/** Monospace code/JSON block. Pretty-prints valid JSON. Enhance later (syntax highlighting). */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  let display = code;
  if (lang === 'json') {
    try {
      display = JSON.stringify(JSON.parse(code), null, 2);
    } catch {
      // not valid JSON — show as-is
    }
  }
  return (
    <div className="not-prose relative my-2">
      {lang && (
        <span className="absolute right-2 top-1.5 rounded bg-background/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {lang}
        </span>
      )}
      <pre className="overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
        <code>{display}</code>
      </pre>
    </div>
  );
}
