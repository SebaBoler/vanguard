---
name: simplify
description: Use after writing or modifying code to improve its clarity, reuse, simplicity, and efficiency without changing behavior. Not for finding correctness bugs — that is code review.
---

# Simplify

Improve the quality of the changed code without changing what it does. Review the diff on four angles
and apply the fixes.

- **Reuse:** does the new code re-implement something the codebase already has? Call the existing
  helper instead of duplicating it.
- **Simplification:** remove redundant or derivable state, copy-paste with slight variation, deep
  nesting, and dead code left behind. Prefer the simplest form that does the same job.
- **Efficiency:** remove wasted work — redundant computation, repeated I/O, sequential calls that
  could run together — when it does not hurt clarity.
- **Altitude:** is each change at the right depth, or a fragile special-case bolted onto shared
  infrastructure? Prefer generalizing the underlying mechanism over stacking special cases.

Skip any change that would alter behavior or reach well outside the diff. Finish by stating what you
simplified.
