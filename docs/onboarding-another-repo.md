# Run Vanguard on your own repo (GitHub Actions)

Label a GitHub issue, get back a reviewed draft PR. The target repo does not need Vanguard installed: the workflow checks Vanguard out beside your code and builds it in the job. Everything runs in a Docker sandbox on the GitHub runner.

You drop in **two workflow files** (required), set **two secrets** and **one repo setting**, run the doctor once, then label an issue. A ready-made **issue template** is optional — it is just a convenient way to produce issues that pass triage; bring your own or none, as long as your issues meet [the triage contract](#what-an-issue-must-contain-the-triage-contract).

> **Cost:** each run uses ~15-20 GitHub Actions minutes — **unlimited on public repos**, 2000/month free on private. To avoid Actions minutes entirely, run an always-on `vanguard watch` on your own host (see [Cost & limits](../README.md#cost--limits) and [docs/deploy.md](deploy.md)).

---

## 1. The files

The two workflows are required. The issue template is optional but recommended.

### `.github/workflows/vanguard-implement.yml` — does the work

```yaml
name: Vanguard Implement
on:
  issues:
    types: [labeled]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  issues: write
concurrency:
  group: vanguard-implement-${{ github.repository }}
  cancel-in-progress: false
jobs:
  implement:
    if: >-
      (github.event_name == 'workflow_dispatch' && github.actor == 'YOUR_LOGIN') ||
      (github.event_name == 'issues' &&
      contains(fromJSON('["ready for spec","ready for agent"]'), github.event.label.name) &&
      github.event.issue.user.login == 'YOUR_LOGIN' &&
      github.event.sender.login == 'YOUR_LOGIN')
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/checkout@v6
        with: { repository: SebaBoler/vanguard, path: .vanguard-src }
      - uses: pnpm/action-setup@v6
        with: { package_json_file: .vanguard-src/package.json }
      - uses: actions/setup-node@v6
        with: { node-version: 24 }
      - run: pnpm install --frozen-lockfile --ignore-workspace
        working-directory: .vanguard-src
      - run: pnpm build
        working-directory: .vanguard-src
      - run: docker build -t vanguard-sandbox:latest .vanguard-src/docker/
      - name: Ensure routing labels
        run: |
          for l in "ready for spec:FBCA04" "ready for agent:5319E7" "needs info:D93F0B" "needs research:1D76DB" \
                   "vanguard:speccing:FEF2C0" "vanguard:running:C5DEF5" "vanguard:needs-human-review:0E8A16" "vanguard:researching:BFDADC"; do
            gh label create "${l%:*}" --repo "$GITHUB_REPOSITORY" --color "${l##*:}" --force
          done
      - name: Run Vanguard loop (spec then implement)
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          node .vanguard-src/dist/cli/index.js watch --source github --github-repo "$GITHUB_REPOSITORY" --repo "$GITHUB_WORKSPACE" --once --skills .vanguard-src/skills --llm-proxy
```

That is the **minimal** form: Claude does plan/implement/review/simplify, the model credential stays in a sidecar (`--llm-proxy`). To run Opus-spec / Sonnet-impl / Codex-review on a ChatGPT subscription instead, see [Full: cross-provider](#full-cross-provider-on-a-codex-subscription) below.

`--ignore-workspace` on the install is what lets this work when **your repo is a pnpm workspace (monorepo)**: otherwise `pnpm install` inside `.vanguard-src` is captured by your root `pnpm-workspace.yaml`, leaves `.vanguard-src/node_modules` empty, and the Vanguard build fails. It is harmless for non-workspace repos — keep it.

### `.github/workflows/vanguard-doctor.yml` — validate before your first issue

```yaml
name: Vanguard Doctor
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: write
  pull-requests: read
concurrency:
  group: vanguard-doctor-${{ github.repository }}
  cancel-in-progress: true
jobs:
  doctor:
    if: github.actor == 'YOUR_LOGIN'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/checkout@v6
        with: { repository: SebaBoler/vanguard, path: .vanguard-src }
      - uses: pnpm/action-setup@v6
        with: { package_json_file: .vanguard-src/package.json }
      - uses: actions/setup-node@v6
        with: { node-version: 24 }
      - run: pnpm install --frozen-lockfile --ignore-workspace
        working-directory: .vanguard-src
      - run: pnpm build
        working-directory: .vanguard-src
      - run: docker build -t vanguard-sandbox:latest .vanguard-src/docker/
      - name: Ensure routing labels
        run: |
          for l in "ready for spec:FBCA04" "ready for agent:5319E7" "needs info:D93F0B" "needs research:1D76DB" \
                   "vanguard:speccing:FEF2C0" "vanguard:running:C5DEF5" "vanguard:needs-human-review:0E8A16" "vanguard:researching:BFDADC"; do
            gh label create "${l%:*}" --repo "$GITHUB_REPOSITORY" --color "${l##*:}" --force
          done
      - name: Doctor (preflight only — no issues processed)
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: node .vanguard-src/dist/cli/index.js doctor --source github --github-repo "$GITHUB_REPOSITORY" --repo "$GITHUB_WORKSPACE"
```

Run it from **Actions → Vanguard Doctor → Run workflow** (clickable from the GitHub mobile app). It processes no issues; it just checks Node, auth, labels, Docker, the sandbox image, and the repo remote, then goes green or red. Run it once on a fresh repo before you label anything.

### `.github/ISSUE_TEMPLATE/vanguard-task.md` — optional, the issue shape triage accepts

**Optional.** You are not required to copy this. You can use your own issue template, or none — what matters is that the issues you label meet [the triage contract](#what-an-issue-must-contain-the-triage-contract). This template is simply the shortest path to issues that pass: it pre-fills the `## Acceptance Criteria` heading and the `ready for agent` label. Without any template, **New issue** gives a blank form and it is easy to omit the heading triage requires.

```markdown
---
name: Vanguard Task / Agent Implementation
about: Submit a well-defined task ready for automatic implementation by Vanguard.
title: "[TASK] "
labels: ready for agent
assignees: ''
---

## 🎯 What are we building? (Context & Goal)
<!-- 1-2 sentences: the goal, and why. -->

## ✅ Acceptance Criteria
<!-- The MOST IMPORTANT section. Replace the examples with real, testable criteria. -->
- [ ] Feature X functions as intended.
- [ ] Tests cover the change.
- [ ] CI passes.

## 🛠 Technical Context / Scope of Changes
* **Main files/modules to modify:** `src/path/to/file.ts`
* **Known constraints:** `...`

---
### 🤖 Triage Instructions (For Humans)
* Change the label to `ready for spec` if this is a high-level idea Vanguard should research and write a Tech Spec for first.
* Leave it `ready for agent` if it is precisely scoped and Vanguard should implement straight away.
```

---

## 2. Secrets and repo setting (one-time)

1. **Secret `CLAUDE_CODE_OAUTH_TOKEN`** — Settings → Secrets and variables → Actions → New repository secret. Generate it locally with `claude setup-token`.
2. **Repo setting** — Settings → Actions → General → Workflow permissions → enable **"Allow GitHub Actions to create and approve pull requests"**. Without it the agent does all the work and then `gh pr create` fails. (CLI: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true`.)
3. (Full tier only) **Secret `CODEX_AUTH_JSON`** — see below.

Replace `YOUR_LOGIN` in both workflows with your GitHub login. The `if:` gate restricts runs to your own issues, so a stranger labelling an issue cannot start a run.

---

## 3. Validate, then use it

1. **Validate:** run **Vanguard Doctor** once. Green means secrets, labels, Docker, and the sandbox image are all in place.
2. **Create an issue:** New issue → the **Vanguard Task** template. Fill in real Acceptance Criteria (replace the placeholders).
3. **Label it:**
   - `ready for agent` — the task is precisely scoped (you wrote the criteria); Vanguard builds it directly.
   - `ready for spec` — a rough idea; Vanguard writes a Tech Spec first, then builds it.
4. Vanguard opens a **draft PR** and moves the issue through `vanguard:running` → `vanguard:needs-human-review`.

---

## Choosing the models

Models are set once, in the `run:` line of the implement workflow — globally for the repo, not per issue. Defaults to all-Claude. Override with flags:

| Stage | Flag | Example |
|---|---|---|
| Plan (spec) | `--spec-model` | `opus` |
| Implement + simplify | `--provider` / `--provider-model` | `claude` / `sonnet` |
| Review | `--review-provider` (+ `--review-model`) | `codex` |

To change which models run, edit the workflow's `run:` line. A cross-provider reviewer (e.g. Codex) uses its own default model; never pass it an Anthropic model name.

### Full: cross-provider on a Codex subscription

To run **Opus** spec / **Sonnet** impl / **Codex** review with Codex on a ChatGPT Plus/Pro subscription (no OpenAI API key):

1. Add the credential as a secret (it holds OAuth tokens from `codex login`, not an API key):
   ```bash
   gh secret set CODEX_AUTH_JSON --repo OWNER/REPO < ~/.codex/auth.json
   ```
2. In the implement workflow's run step, forward the secret and set the flags, and **drop `--llm-proxy`** (a subscription talks to the ChatGPT backend, which the proxy allowlist does not cover):
   ```yaml
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
        run: |
          node .vanguard-src/dist/cli/index.js watch --source github --github-repo "$GITHUB_REPOSITORY" --repo "$GITHUB_WORKSPACE" --once --skills .vanguard-src/skills --spec-model opus --provider claude --provider-model sonnet --review-provider codex
   ```

The stored `CODEX_AUTH_JSON` is a snapshot; Codex refreshes the access token from the embedded refresh token each run, so the secret must carry a live refresh token. Re-run `gh secret set` if a run ever fails to authenticate.

---

## One run, spec and build

`watch --once` does a spec pass then an implement pass in the same invocation. A `ready for spec` ticket is specced and built in one job: the spec pass generates the tech spec and advances the ticket to `ready for agent`, and the implement pass immediately picks it up without relying on GitHub's label index (which has eventual-consistency lag). A `ready for agent` ticket that was already labelled before the run is also picked up in the same pass.

## What an issue must contain (the triage contract)

This is the only hard requirement on issue content — independent of whether you use the template, your own, or none. Before spending model budget, the implement pass refuses an under-specified ticket. To pass, a `ready for agent` issue needs **one** of:

- a `## Acceptance Criteria` markdown heading (any level, emoji prefix is fine) followed by at least one **real** bullet (the template's example bullets do not count — replace them), **or**
- a Vanguard `<tech_spec>` comment, which the spec pass writes automatically for tickets you label `ready for spec`.

What does **not** pass: a plain `Acceptance criteria:` line with no `#` heading, or only the placeholder bullets. A ticket that meets neither condition is moved to `needs info` with a comment explaining what to add; fill it in and re-label.

So: do whatever you like for issue authoring (template, your own, freehand) — just make sure a `ready for agent` issue carries that heading + real bullets, or hand it to the spec pass with `ready for spec`.

## Label reference: routing vs enrichment

| Label | Set by | Bot state | Meaning | Bot action | Auto-advance? |
|---|---|---|---|---|---|
| `ready for spec` | Human | `vanguard:speccing` | Ticket is ready to be specced | Generate tech spec, post `<tech_spec>` comment, advance to `ready for agent` | Yes → `ready for agent` |
| `ready for agent` | Human or spec pass | `vanguard:running` | Ticket is ready to implement | Implement and open a draft PR | Yes → `vanguard:needs-human-review` |
| `needs info` | **Vanguard triage** (`assessTaskReadiness`) | — | Ticket is too vague to proceed — **rejected/parked** | Post clarification comment, stop | No — human must add content |
| `needs research` | **Human** (manually) | `vanguard:researching` | Ticket is a valid idea needing **external context** before speccing | Run external research, post findings comment, **REST** | No — human sets `ready for spec` or `ready for agent` next |

### `needs research` vs `needs info`

These are orthogonal signals and must not be conflated:

- **`needs info`** is an automated *rejection* for under-specified tickets. Vanguard sets it when `assessTaskReadiness` fails (description too short, no acceptance criteria). The human must add content before the ticket can be picked up again.
- **`needs research`** is a human-initiated *enrichment* request for a well-formed ticket that would benefit from external context (prior art, standards, library docs). Vanguard does not apply the `needs_info` gate to the research pass — external research is valuable even for a one-line idea, and gating it would conflate the two signals.

The research pass is **iterative and resting**: each time a human re-applies `needs research`, Vanguard posts a new research comment that builds on prior findings (appends — never replaces). The issue rests with no routing label after each run; the human decides what comes next.

### Egress note for `needs research`

The research sandbox runs under the same egress allowlist as the spec and agent passes by default (`api.anthropic.com` + package registries — no general web). The `--web` CLI flag declares that the operator has widened egress to allow web search/fetch. Without `--web`, the agent conducts model-knowledge research and the comment header says so. To enable true web research, add the following hosts to a research-specific egress extension (do **not** widen `DEFAULT_EGRESS_ALLOWLIST` for the build passes):

- Common documentation hosts: `developer.mozilla.org`, `docs.github.com`, `pkg.go.dev`, `docs.rs`
- Standards bodies: `datatracker.ietf.org`, `www.w3.org`, `tc39.es`
- General search/fetch: your preferred search API endpoint

The `vanguard-research.yml` workflow (not yet applied — see below) must pass `--web` if egress has been widened.
