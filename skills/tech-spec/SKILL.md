---
name: tech-spec
description: Use when a task is under-specified and needs a written technical specification BEFORE any code is written or changed. This skill only researches and documents — it never edits source files. Do not invoke for implementing, reviewing, or simplifying existing code.
---

# Tech Spec

Research the codebase read-only and produce a precise technical specification for the given task.
Do not edit, create, or delete any source files.

## Sections to include

### Problem
What exactly needs to be solved and why. Identify the gap between the current state and the desired
state. Name the stakeholders and the concrete pain point. Check the ticket's premise against the code
first: if the proposed mechanism already exists, or the real gap is elsewhere, say so here and
re-scope the spec to the actual gap rather than specifying a duplicate.

### Architecture
Components involved, interfaces changed or added, data flows, and integration points with the rest
of the system. Include sequence or data-flow sketches if the interaction is non-trivial.

### Acceptance Criteria
Numbered, testable conditions that define done. Each criterion must be verifiable without ambiguity
**from the repository state and the diff alone**: a command that exits 0, a test that passes, a file
that contains or no longer contains something, a commit message in `git log` where tooling gates on
its form (release-please reads the `feat:`/`fix:` prefix). Never require an artifact outside the repo
(a file under `/tmp`, a captured baseline) or a CI run — the implementer does not control those, and
such a criterion only turns a complete change into a "partial scope" delivery. Put any baseline
numbers the implementer must match into the spec itself. The one PR-body criterion that is allowed is
the one `CLAUDE.md` prescribes: when the task needs a CI-config edit the agent must not make, the AC
is "the PR body describes the needed edit for a human to apply".

### Tests
Test cases and scenarios that must pass, including edge cases, failure paths, and integration
boundaries. Name the test file(s) and key scenarios explicitly.

### Risks
Known unknowns, edge cases, backward-compatibility concerns, and failure modes. Call out any
assumption that, if wrong, would invalidate the design.

### Performance / Scalability
Throughput and latency expectations, growth projections, and any bottleneck or scaling limit
introduced or removed by the change.

## Output format

Wrap the complete specification in `<tech_spec>...</tech_spec>`. End with `<promise>COMPLETE</promise>`.
