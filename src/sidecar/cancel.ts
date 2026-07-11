/**
 * Current-run cancellation for the sidecar. Cancel is out-of-band: the desktop sends the sidecar
 * process a SIGUSR1 (an in-band stdio message would queue behind the run it must cancel), and the
 * handler aborts the run's controller WITHOUT exiting, so the loop stays alive for the next run.
 * Single-in-flight ⇒ one current controller at a time.
 */
let current: AbortController | undefined;

/** Mint a fresh controller for a starting run and make it current. Returns its signal for the runner. */
export function beginRun(): AbortSignal {
  current = new AbortController();
  return current.signal;
}

/** Clear the current controller once a run ends (so a stray signal can't abort the next run's setup). */
export function endRun(): void {
  current = undefined;
}

/** Abort the current run, if any. No-op when idle. Called by the SIGUSR1 handler. */
export function cancelCurrent(): void {
  current?.abort();
}

/** Install the SIGUSR1 → cancelCurrent handler once. The process does NOT exit on the signal. */
export function installCancelHandler(): void {
  process.on('SIGUSR1', cancelCurrent);
}
