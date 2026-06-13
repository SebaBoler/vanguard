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
state. Name the stakeholders and the concrete pain point.

### Architecture
Components involved, interfaces changed or added, data flows, and integration points with the rest
of the system. Include sequence or data-flow sketches if the interaction is non-trivial.

### Acceptance Criteria
Numbered, testable conditions that define done. Each criterion must be verifiable without ambiguity.

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
