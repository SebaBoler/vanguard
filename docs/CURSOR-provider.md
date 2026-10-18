# Provider note — `cursor`

`--provider cursor` (and `--review-provider` / `--fallback-provider cursor`) runs a stage on the
[Cursor CLI](https://cursor.com/docs/cli/overview) (`agent`) inside the sandbox, in headless print mode:

```bash
agent -p --output-format stream-json --force --trust --sandbox disabled [--model <m>] [--resume <chatId>]
```

The prompt goes on stdin. `--sandbox disabled` turns off Cursor's own sandbox: the Vanguard container
is the boundary, as with codex's `danger-full-access`.

## Setup

1. **Key.** Create a user API key at [cursor.com/dashboard/api](https://cursor.com/dashboard/api) and
   export it as `CURSOR_API_KEY`. It is forwarded into the sandbox only when cursor is selected; a
   missing key fails at dispatch (and in `vanguard doctor`). Runs bill against that account's plan.
2. **Image.** The CLI is opt-in in the sandbox image (~550 MB unpacked). Build with a version id from
   `cursor.com/install`:

   ```bash
   CURSOR_CLI_VERSION=2026.10.16-e3cb207 ./docker/build.sh
   ```

   `vanguard doctor` checks for `agent` in the image whenever cursor is one of the providers.
3. **GitHub Actions.** The reusable workflows install the CLI when `provider`, `review-provider` or
   `fallback-provider` is `cursor` (version from the `cursor-cli-version` input) and pass the optional
   `CURSOR_API_KEY` secret through. The caller must forward it:

   ```yaml
   secrets:
     CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
   ```

## Behaviour

- **Models.** `--provider-model` passes through (`gpt-5`, `sonnet-4-thinking`, … — see `agent models`).
  The Claude aliases and ids Vanguard's presets pin (`haiku`, `sonnet`, `opus`, `claude-sonnet-5-5`,
  `claude-fable-5-1`, …) are dropped, so those stages run on the account's default model. The model in
  run records and `stats` is Cursor's display name from the stream (e.g. "Claude 4 Sonnet").
- **Resume.** Repair-gate repairs and the spec resume nudge pass `--resume <chatId>`; the chat lives in
  the run's sandbox. No session jsonl is captured or restored (that is Claude-only).
- **System prompt.** Cursor has no system-prompt flag, so a stage's system prompt leads the stdin prompt.
- **Skills.** Injected as `.cursor/rules/<id>.mdc` (`alwaysApply: false`); bodies under
  `.vanguard/skills/`. Neither is copied back into the PR diff.
- **Egress.** `--egress` allows `cursor.sh` (api2 and the api5 agent subdomains).

## Limitations

- **No usage or cost.** Cursor's stream reports neither, so stage cost is 0: the run cost cap
  (`maxCostUsd`) and the per-stage caps never stop a cursor stage — only the stage timeout does.
  `$or-est` shows `n/a`.
- **No max turns.** The CLI has no turn cap; `maxTurns` is not enforced.
- **Not proxied.** Under `--llm-proxy` the Cursor key is still injected into the sandbox, and the run
  still needs a primary-sidecar credential (Claude, z.ai or OpenRouter) even when every stage is cursor.
- **Hub live view.** It reads Claude session files, so cursor stages do not stream there.

## Still to verify with a live key

The parser and fixture follow [cursor.com/docs/cli/reference/output-format](https://cursor.com/docs/cli/reference/output-format);
they have not yet been checked against a recorded stream from this CLI version. Open items: stdin
prompts in print mode, `--resume` across two `agent -p` calls in one container, whether `agent` honours
the egress proxy's `HTTPS_PROXY`, the exact hosts it reaches, and the key format (for redaction).
