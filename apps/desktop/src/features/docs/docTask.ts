/**
 * Mirrors MAX_BODY_BYTES in `src/tasks/create.ts`. The desktop is a separate package with no import
 * path into core (see typedRunReducer's RunEvent, same gap), so this is a copy — KEEP IN SYNC.
 *
 * It is only a UX guard: the sidecar enforces the real limit independently, so drifting out of sync
 * degrades the message, not the safety. Refusing here means the user is told BEFORE committing to an
 * irreversible click, rather than after.
 */
export const MAX_BODY_BYTES = 60_000;

/**
 * The doc's title: its first `# ` heading.
 *
 * Returns undefined when there isn't one — the caller must REFUSE rather than invent a title (falling
 * back to the filename, or the first line, would create a real, un-deletable issue named `note-3.md`).
 * Pure so it can be tested without a DOM; CodeMirror cannot be driven under jsdom.
 */
export function titleFromDoc(doc: string): string | undefined {
  let fenced = false;
  for (const line of doc.split('\n')) {
    // A ``` fence toggles code. `# install deps` inside a shell snippet is a comment, not the doc's
    // heading — taking it would file a real, un-deletable issue under a name the user never wrote.
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    // Closed-ATX headings (`# Title #`) carry trailing hashes that are syntax, not title.
    const m = line.match(/^#\s+(.*?)\s*#*\s*$/);
    const title = m?.[1];
    if (title !== undefined && title !== '') return title;
  }
  return undefined;
}
