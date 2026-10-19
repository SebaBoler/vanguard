# Provider note — `cursor`

`--provider cursor` (and `--review-provider` / `--fallback-provider cursor`) runs a stage on the
[Cursor CLI](https://cursor.com/docs/cli/overview) (`agent`) inside the sandbox, in headless print mode:

```bash
agent -p --output-format stream-json --trust --sandbox disabled [--model <m>] [--resume <chatId>]
```

The prompt goes on stdin. Before each call the provider writes a permission allowlist
(`Shell(*)`, `Read(**)`, `Write(**)`) into the sandbox's `~/.cursor/cli-config.json`, keeping the rest of
the file. It does this instead of passing `--force`, because a team admin can disable "Run Everything", and then
`--force` aborts the run. Without either one, print mode rejects every shell command except `ls`.
`--sandbox disabled` turns off Cursor's own sandbox. In both cases the Vanguard container is the
boundary, as with codex's `danger-full-access`.

## Setup

1. **Key.** Create a user API key at [cursor.com/dashboard/api](https://cursor.com/dashboard/api) and
   export it as `CURSOR_API_KEY`. It is forwarded into the sandbox only when cursor is selected, and a
   missing key fails at dispatch (and in `vanguard doctor`). Runs bill against that account's plan. Keys
   (`crsr_…`) are redacted from logs and blocked by the diff secret scan.
2. **Image.** The CLI is opt-in in the sandbox image. It adds about 760 MB. Build it with a version id from
   `cursor.com/install`:

   ```bash
   CURSOR_CLI_VERSION=2026.10.16-e3cb207 ./docker/build.sh
   ```

   `vanguard doctor` checks for `agent` in the image whenever cursor is one of the providers.
3. **GitHub Actions.** The reusable workflows install the CLI when `provider`, `review-provider` or
   `fallback-provider` is `cursor`. The version comes from the `cursor-cli-version` input. They also pass
   the optional `CURSOR_API_KEY` secret through. The caller has to forward it:

   ```yaml
   secrets:
     CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
   ```

## Behaviour

- **Models.** `--provider-model` takes a Cursor id from `agent models`, for example `auto` (the default),
  `gpt-5.6-sol-high` or `claude-sonnet-5-thinking-high`. The Claude aliases and Anthropic ids that
  Vanguard's presets pin (`haiku`, `sonnet`, `opus`, `claude-sonnet-5-5`, `claude-fable-5-1`, …) are
  dropped, so those stages run on the account default. Run records and `stats` show Cursor's display
  name from the stream, for example "Auto Balance".
- **Usage.** Token usage comes from the `result` event (input, output, cache-read). Cursor reports no
  cost.
- **Resume.** Repair-gate repairs and the spec resume nudge pass `--resume <chatId>`. The chat lives in
  the run's sandbox under `~/.cursor`. No session jsonl is captured or restored; that is Claude-only.
- **System prompt.** Cursor has no system-prompt flag, so a stage's system prompt goes at the start of
  the stdin prompt.
- **Skills.** They are injected as `.cursor/rules/<id>.mdc` (`alwaysApply: false`), with the bodies under
  `.vanguard/skills/`. Neither is copied back into the PR diff.
- **Egress.** `agent` honours `HTTPS_PROXY` and reaches only `api2.cursor.sh` and
  `agentn.*.api5.cursor.sh`. Both are covered by the `cursor.sh` allowlist entry.

## Limitations

- **No cost.** Stage cost is 0, so the run cost cap (`maxCostUsd`) and the per-stage caps never stop a
  cursor stage. Only the stage timeout does. `$or-est` shows `n/a`.
- **No max turns.** The CLI has no turn cap, so `maxTurns` is not enforced.
- **Not proxied.** Under `--llm-proxy` the Cursor key is still injected into the sandbox. The run still
  needs a primary-sidecar credential (Claude, z.ai or OpenRouter), even when every stage is cursor.
- **Hub live view.** The view reads Claude session files, so cursor stages do not stream there.

## Verified

Checked with CLI 2026.10.16-e3cb207 in the sandbox image, using a team key whose admin disabled "Run
Everything". The real `CursorProvider` ran with the prompt on stdin. It edited a file and ran a shell
command, with no `--force` and a Claude model dropped to `auto`. A second call with `--resume` in the
same container recalled the first. The recorded stream is the test fixture
(`src/agents/cursor-stream.fixture.ndjson`). Not yet run: a full `vanguard run`/factory pipeline on
cursor.
