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

## Severity and the merge gate

Label every finding with the repository's own vocabulary — severity `low | medium | high | critical`,
kind `security | perf | correctness | style`. `high` and `critical` are **blocking**: they turn the
verdict into request-changes and stop the merge. Do not invent another scale, and do not call a style
or maintainability point blocking.

## Verify before you block

- A claim about how a platform or tool behaves (GitHub Actions contexts, git semantics, a library's
  API, a CI setting) is not a finding until you have checked it against the documentation or
  reproduced it. Cite what you checked. An unverified claim is at most `medium`, stated as a question.
- Mark each finding **verified** (you traced the code, ran it, or reproduced it) or **inferred**.
- Run the project's gates when the checkout allows — here `pnpm lint`, `pnpm typecheck`, `pnpm test` —
  and say which ran. `tsc` does not catch unused imports; lint does, and CI gates on it.
- Follow the repository's review guidance (for this repo: `CLAUDE.md`, "Review guidance"). A CI-config
  edit in a PR by a trusted author is reviewed on its content, not flagged for the constraint itself.
- Do not re-raise a gap the author already disclosed as known unless you bring new evidence.

## How to report and act

Only act on issues you are confident are real — skip speculative nitpicks. For each real issue, fix it
directly in the repo (this is a working review, not a comment-only pass). State what you changed and
why. If something is a genuine design concern beyond this change, note it rather than forcing a fix.
