---
name: code-review
description: Use when reviewing a code change or diff for correctness, security, missing tests, and convention violations before opening or approving a PR. Review independently and adversarially, then fix high-confidence issues.
---

# Code Review

Review the change as an independent reviewer who did not write it. Read the diff and the surrounding
code, then judge it adversarially.

## What to check

- **Correctness:** logic errors, off-by-one, wrong conditionals, unhandled `null`/`undefined`, broken
  control flow, race conditions. Trace the actual execution, don't skim.
- **Error handling at real boundaries:** I/O, subprocess, network, parsing. No silent failures, no
  swallowed errors, no fallback that hides a real problem.
- **Security:** injection, path traversal, leaked secrets, unsafe input reaching a shell/filesystem.
- **Tests:** does new behavior have a test? Are edge cases and failure paths covered? Run the
  project's tests/typecheck if you can.
- **Conventions:** match the surrounding code's style, naming, and patterns. No new dependency or
  abstraction that the codebase already provides.

## How to report and act

Only act on issues you are confident are real — skip speculative nitpicks. For each real issue, fix it
directly in the repo (this is a working review, not a comment-only pass). State what you changed and
why. If something is a genuine design concern beyond this change, note it rather than forcing a fix.
