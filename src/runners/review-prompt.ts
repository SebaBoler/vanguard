/** Prompt text shared by the PR and MR review builders. */

/** Prepended on the incomplete-review retry so the larger budget ends in a verdict instead of a second timeout. */
export const RETRY_TRIAGE_INSTRUCTION =
  'This is a large diff. Do not attempt to read every file exhaustively. Triage: scan the whole diff first, then focus only on the highest-risk changes (correctness, security, data loss, broken contracts). Produce your verdict within the turn budget. If you cannot cover everything, report the findings you are confident in and state what you did not cover, but you MUST finish with a verdict and <promise>COMPLETE</promise>.';
