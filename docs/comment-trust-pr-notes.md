# PR notes: comment author trust

Autonomous revision, manifest, readiness and research decisions now reject unauthorised comment authors. GitHub associations OWNER/MEMBER/COLLABORATOR, explicit allowlists and (for issue specifications) the issue author establish trust. Bot comments supply specifications and iteration markers but are excluded from actionable revision feedback.

The shared bot matcher uses an exact `vanguard` login rather than a substring: an outsider can choose a username such as `mallory-vanguard`. Custom bot logins can be supplied explicitly. GitHub issue comments retain the existing `gh issue view --json comments` source: GitHub CLI's [Comment definition](https://github.com/cli/cli/blob/trunk/api/queries_comments.go) includes `authorAssociation`. Live authenticated verification was unavailable in this checkout.

GitLab notes have no association: maintainers who did not open the issue must be allowlisted. Linear comments are treated as MEMBER because workspace membership gates commenting; guest/public commenting would require revisiting that assumption.

## Manual workflow edits

Workflow files are deliberately unchanged. Until these edits land, allowlisted non-members must pass `--feedback-authors` themselves or their comments will be ignored.

In `revise.yml`'s **Revise the PR from review comments** step, add this to `env:`:

```yaml
IN_ALLOWED_ACTORS: ${{ inputs.allowed-actors }}
```

In the step's `run:` body, add these exact lines (no expression interpolation inside `run:`):

```bash
AUTHORS=$(printf '%s' "$IN_ALLOWED_ACTORS" | tr -d '[]" ' )
[ -n "$AUTHORS" ] && args+=(--feedback-authors "$AUTHORS")
```

Apply the identical environment entry and two shell lines in `implement.yml`'s **Run Vanguard loop** step. No trigger, permissions or actor-gate change is required.

## Follow-up

Track narrowing comment context separately: `taskToVariables`'s COMMENTS variable and the difficulty probe still receive all comments as escaped, untrusted context. This change gates autonomous decisions but does not eliminate model influence from contextual text.
