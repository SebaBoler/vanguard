---
name: Vanguard Task / Agent Implementation
about: Submit a well-defined task ready for automatic implementation by Vanguard.
title: "[TASK] "
labels: ready for agent
assignees: ''
---

## 🎯 What are we building? (Context & Goal)
<!-- Describe in 1-2 sentences the main goal of this task. Why are we building or fixing this? -->


## ✅ Acceptance Criteria
<!-- This is the MOST IMPORTANT section for Vanguard. The agent will use this as its primary "Goal". List the exact, measurable conditions that must be met to consider the task complete. -->
- [ ] Feature X functions as intended.
- [ ] Unit tests are written or updated to cover the new changes.
- [ ] The existing CI pipeline passes successfully.
- [ ] Optional: Relevant documentation is updated.

## 🛠 Technical Context / Scope of Changes
<!-- Optionally provide hints on where the agent should start or specific constraints it needs to respect. -->
* **Main files/modules to modify:** `src/path/to/file.ts`
* **Known constraints:** `...`

---
### 🤖 Triage Instructions (For Humans):
* Change the label to `ready for spec` – if this task is just a high-level idea and Vanguard should first research it, prepare an architectural plan, and write a Tech Spec.
* Leave the label as `ready for agent` – if the task is precisely scoped out and Vanguard should jump straight into the isolated implementation phase and open a Pull Request.
* Add the `vanguard` label only when your watcher is started with an ownership guard such as `--label vanguard`. Repo-wide GitHub Loop v1.1 can run on `ready for spec` / `ready for agent` alone.
