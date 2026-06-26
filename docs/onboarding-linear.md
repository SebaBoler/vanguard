# Run Vanguard on Linear

The Linear counterpart of [docs/onboarding-another-repo.md](onboarding-another-repo.md). Same pipeline (spec → implement → review → simplify → draft GitHub PR), two differences from the GitHub flow:

- **Routing is by STATE, not labels.** GitHub uses `ready for spec` / `ready for agent` labels; Linear uses workflow **states** (state types: `triage`, `unstarted`, …). A `vanguard` label is an ownership tag the issue must carry.
- **No GitHub-Actions equivalent.** Linear has no CI trigger, so you run an **always-on `vanguard watch --source linear`** on a host (a server, or the Synology deploy — see [docs/deploy.md](deploy.md)). It is still phone-drivable: change an issue's state from the Linear app and the watcher picks it up on the next poll.

GitHub is still the review surface — the PR opens on the linked GitHub repo and the PR link is commented back onto the Linear issue. **Non-GitHub VCS:** GitLab workspaces open MRs instead (`glab mr create --fill`); the Linear issue receives the MR link the same way. Any VCS with a CLI that can open a review request works — the watcher is not GitHub-specific.

---

## 0. Pre-flight check

Before dispatching an issue, verify the feature is not already implemented:

```bash
# grep for key symbols or behavior from the issue title/description
grep -r "symbolOrBehavior" src/
```

If the implementation exists on the default branch, close the Linear task and skip the run. A full model budget spent on an empty diff is wasted budget.

---

## 1. Run the watcher

On a host with the repo checked out and the sandbox image built (`docker/build.sh`), set the env and start the loop. Validate first:

```bash
export LINEAR_API_KEY=...                 # Linear API key (or `linear auth login`)
export CLAUDE_CODE_OAUTH_TOKEN=...         # Claude subscription token

vanguard doctor --loop-v1 --label vanguard --repo /path/to/repo   # preflight: no work claimed
vanguard watch  --loop-v1 --label vanguard --repo /path/to/repo   # the loop
```

`--loop-v1` is the Linear two-pass loop; `--label vanguard` is the ownership tag (only issues carrying it are picked up). Defaults: spec pass fires on state type `triage`, agent pass on `unstarted` (e.g. the `Todo` state), vague tickets move to `Needs Info`. Override with `--spec-state` / `--agent-state` / `--needs-info-state` / `--spec-model` if your workspace uses different state names.

Run it always-on in Docker (Synology / Hetzner / any host): see [docs/deploy.md](deploy.md). The shipped Synology deploy already runs `watch --source linear --team TES --label vanguard`.

**Disk management:** Docker-based sandboxes accumulate build cache silently. On long-running hosts, run `docker builder prune -f` before starting the watcher to prevent silent mid-run failures — package installs fail with no free space but no clear error message.

---

## 2. State routing (the equivalent of GitHub labels)

| Linear state | GitHub label equivalent | What happens |
|---|---|---|
| **Triage** (type `triage`) + `vanguard` label | `ready for spec` | Spec pass: triage, then `techSpecStage` posts a `<tech_spec>` comment and moves the issue to the agent state (`Todo`). |
| **Todo** (type `unstarted`) + `vanguard` label | `ready for agent` | Agent pass: Implementer → Reviewer → Simplifier → draft PR. (The spec pass moves a specced issue here; an already-`Todo` issue is built directly.) |
| **Needs Info** | `needs info` | Parked: the ticket was too vague. Fill it in and move it back. |

The two-flag split is Linear-specific: `--agent-state` is the **state name** the spec pass moves a ticket to (`Todo`), while `--trigger-state` is the **state type** the agent pass fires on (`unstarted`). The default `Todo` is of type `unstarted`, so they line up out of the box.

**Single-pass variant:** The two-pass flow (Triage → spec → Todo → build) assumes tickets arrive under-specified. If your team writes detailed specs before tagging `vanguard`, the spec/triage pass is unnecessary overhead. Apply the `vanguard` label only to issues already in the agent state (`Todo`/`unstarted`) that satisfy the [triage contract](#3-the-triage-contract-same-as-github) — a `## Acceptance Criteria` heading followed by real bullets. (A free-form "complete spec" in the description that lacks the literal heading is bounced to **Needs Info** by the agent pass, the exact wasted-budget outcome this skips.) The watcher then builds them directly, skipping the spec pass entirely.

---

## 3. The triage contract (same as GitHub)

Independent of routing, before spending model budget the agent pass refuses an under-specified ticket. To pass, a ticket in the agent state needs **one** of:

- a `## Acceptance Criteria` markdown heading in the description followed by at least one **real** bullet (placeholders do not count), **or**
- a Vanguard `<tech_spec>` comment, which the spec pass writes for tickets you put in **Triage**.

A ticket meeting neither is moved to **Needs Info** with a clarification comment. Same contract as the GitHub onboarding — see [the triage contract there](onboarding-another-repo.md#what-an-issue-must-contain-the-triage-contract).

**Quality calibration:** Keep one or two reference issues with known-good specs bookmarked in your workspace. Link them in the issue description or team docs as calibration examples for what "ready to run" looks like. Vague tickets cost a full run budget to reject.

---

## 4. Test plan (mirrors the GitHub tiers)

- **Minimal** — issue in **Todo** + `vanguard` label, with `## Acceptance Criteria` + real bullets in the description → watcher builds directly → draft PR.
- **Intermediate** — issue in **Triage** + `vanguard` label → watcher writes the tech spec, moves it to Todo, then builds it → PR.
- **Vague** — a one-line issue in Triage + `vanguard` → moved to Needs Info (triage rejects it).
- **Full (cross-provider on a Codex subscription)** — start the watcher with the cross-provider flags and `CODEX_AUTH_JSON` in the env:
  ```bash
  export CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"   # ChatGPT subscription credential (see onboarding-another-repo.md)
  vanguard watch --loop-v1 --label vanguard --repo /path/to/repo \
    --spec-model opus --provider claude --provider-model sonnet --review-provider codex
  ```

Models are chosen the same way as GitHub (`--spec-model` plans, `--provider`/`--provider-model` implement + simplify, `--review-provider` reviews). The Codex subscription credential and its CI caveat are identical — see [onboarding-another-repo.md](onboarding-another-repo.md#full-cross-provider-on-a-codex-subscription).

---

## 5. Post-run checklist

After the watcher finishes and a draft PR/MR exists:

1. **Check the diff stat** — every layer the spec demanded actually landed. A schema change without the corresponding module, or a missing test, means the run stopped short → resume or finish by hand.
2. **Run the verify gate** — `typecheck` + lint (whatever the project uses). The agent may have left type errors it did not notice.
3. **Spot-check auth/security** — resolver ownership filters, webhook signature verification, feature gates. These are the areas agents most commonly skip under time pressure.
4. **Open the review request** — push the draft PR/MR out of draft and post the link as a comment on the Linear issue.
5. **Close the loop** — mark the Linear issue **Done**. File any newly discovered bugs as separate issues.
