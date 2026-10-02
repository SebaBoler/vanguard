import { VanguardError } from './errors.js';

/**
 * Reject a base branch git would misread when it is passed as a bare argument. A leading "-" parses
 * as an option (e.g. --upload-pack=<cmd>). A ":" or a leading "+" makes `git fetch origin <base>` a
 * refspec that writes, or force-overwrites, a local branch. A blank base names no branch at all, and
 * git never allows a control character in a ref, which would otherwise reach log lines raw.
 */
export function assertSafeBaseBranch(base: string): void {
  if (base.trim() === '') throw new VanguardError('Invalid base branch: it cannot be empty');
  if (base.startsWith('-') || base.startsWith('+') || base.includes(':') || /[\x00-\x1f\x7f]/.test(base)) {
    throw new VanguardError(`Invalid base branch ${JSON.stringify(base)}: it cannot start with "-" or "+", or contain ":" or a control character`);
  }
}
