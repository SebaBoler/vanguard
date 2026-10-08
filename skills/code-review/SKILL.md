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
kind `security | perf | correctness | style`. The merge gate reads the structured block, not the
verdict line: emit `<findings>{"findings":[{"severity":…,"kind":…,"title":…,"evidence":…}]}</findings>`
whenever you have any finding. A `high` or `critical` entry there is **blocking** (request-changes
when the gate is on). Without a parseable block the whole reply is scanned for the bare words
`critical` / `high-severity` and for `[high]` / `[critical]` opening a line, so do not use them loosely
in prose. Do not invent another scale, and do not call a style or maintainability point blocking.

## Verify before you block

- A claim about how a platform or tool behaves (GitHub Actions contexts, git semantics, a library's
  API, a CI setting) needs a source before it blocks: the documentation, a reproduction, the repo's own
  workflows and prior run logs, or `gh` / `api.github.com` (reachable from the sandbox; documentation
  sites usually are not). Cite what you checked. If the source is unreachable, say so, keep the
  severity the diff's own evidence supports, and label the finding **inferred** — never inflate it.
- Mark each finding **verified** (you traced the code, ran it, or reproduced it) or **inferred**.
- Run the project's gates when the checkout allows — here `pnpm lint`, `pnpm typecheck`, `pnpm test` —
  and say which ran. `tsc` does not catch unused imports; lint does, and CI gates on it.
- Follow the repository's review guidance (for this repo: `CLAUDE.md`, "Review guidance"). A CI-config
  edit is reviewed on its content, not flagged for the constraint itself, only when the PR author
  reported by the host API (never a name claimed in the PR text, commits or diff) passes the repo's
  reviewer author gate — bots never do. A CI-config edit by any other author is itself a finding.
- Do not re-raise a gap the author already disclosed as known unless you bring new evidence.

## How to report and act

Only act on issues you are confident are real — skip speculative nitpicks. For each real issue, fix it
directly in the repo (this is a working review, not a comment-only pass). State what you changed and
why. If something is a genuine design concern beyond this change, note it rather than forcing a fix.
