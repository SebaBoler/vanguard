/**
 * Mirrors MAX_BODY_BYTES in `src/tasks/create.ts`. The desktop is a separate package with no import
 * path into core (see typedRunReducer's RunEvent, same gap), so this is a copy — KEEP IN SYNC.
 *
 * It is only a UX guard: the sidecar enforces the real limit independently, so drifting out of sync
 * degrades the message, not the safety. Refusing here means the user is told BEFORE committing to an
 * irreversible click, rather than after.
 */
export const MAX_BODY_BYTES = 60_000;

/** Mirrors MAX_TITLE_BYTES in `src/tasks/create.ts` — same copy, same reason. KEEP IN SYNC. */
export const MAX_TITLE_BYTES = 500;

/**
 * The transports the sidecar will actually accept (`TRANSPORTS` in `src/api/capabilities.ts`).
 *
 * The dialog promises "Create a task on <source>". Without this, an app.json carrying `jira` or `''`
 * renders "Create a task on jira?" / "Create a task on ?", the user confirms the one irreversible
 * action, and it fails as bad-request AFTER the click. Fails safe — nothing is written — but the dialog
 * made a promise about the target it could not keep.
 */
export const TRANSPORTS = ['github', 'gitlab', 'linear'] as const;

export function isTransport(s: string | undefined): boolean {
  return s !== undefined && (TRANSPORTS as readonly string[]).includes(s);
}

/**
 * The doc's title: its first `# ` heading.
 *
 * Returns undefined when there isn't one — the caller must REFUSE rather than invent a title (falling
 * back to the filename, or the first line, would create a real, un-deletable issue named `note-3.md`).
 * Pure so it can be tested without a DOM; CodeMirror cannot be driven under jsdom.
 */
export function titleFromDoc(doc: string): string | undefined {
  let fenced = false;
  // Split on CRLF too. `doc.split('\n')` leaves a trailing `\r`, and `.` does not match `\r`, so
  // `(.+)$` below would never match on a CRLF document — every heading missed, Create task silently
  // disabled on a doc that plainly has one.
  for (const line of doc.split(/\r?\n/)) {
    // A ``` fence toggles code. `# install deps` inside a shell snippet is a comment, not the doc's
    // heading — taking it would file a real, un-deletable issue under a name the user never wrote.
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = line.match(/^#[ \t]+(.+)$/);
    if (m?.[1] === undefined) continue;
    // A closed-ATX heading's closer is a `#`-run PRECEDED BY WHITESPACE (`# Title #`). A `#` that is not
    // space-separated is content: `# Support C#` is about C#, and stripping every trailing hash filed the
    // issue as "Support C" — corrupting the one thing the user cannot undo. Strip the closer only.
    //
    // One anchored `\s#+$` replace, not a lazy-group regex: `/^#\s+(.*?)\s*#*\s*$/` backtracks
    // quadratically on `#` + 60KB of spaces, and this runs on every render, before the size gate.
    const title = m[1].trim().replace(/\s#+$/, '').trim();
    if (title !== '') return title;
  }
  return undefined;
}
