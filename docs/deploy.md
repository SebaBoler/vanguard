# Deploying the Vanguard watch loop (Synology / Hetzner / any Docker host)

Run `vanguard watch` always-on so the factory pulls ready Linear/GitHub issues by itself. Synology
and Hetzner are the same target: Docker on Linux. This is a template — validate it on your host.

## Architecture (docker-out-of-docker)

Vanguard runs as one long-lived container (the **controller**). It talks to the host Docker daemon
through the mounted socket and starts **sibling** sandbox containers for each run.

```
host docker daemon
 ├─ vanguard-watch        (controller: node + docker CLI + git + gh + linear)
 │     └─ uses /var/run/docker.sock
 └─ vg-<uuid> ...         (per-run sandboxes, started by the controller as siblings)
```

Why this works without path tricks: the controller copies the worktree into each sandbox with
`docker cp` (source read from the controller's own filesystem) and injects secrets via tmpfs — it
never bind-mounts the worktree, so there is no "host path must match" gotcha. The one requirement:
the **sandbox image must exist on the host daemon** (build/pull it on the host, see below).

## Prerequisites on the host

1. Docker (Synology: Container Manager; Hetzner: `apt install docker.io` or Docker CE).
2. Build the sandbox image on the host daemon: `docker/build.sh` (it must be visible to the same
   daemon the controller uses). Confirm the architecture matches (x86_64 vs arm64 — some Synology are
   arm64; `claude` and `linear` CLIs must have that arch).
3. A clone of the target repo the agent edits (mounted into the controller, see compose).
4. Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`), `LINEAR_API_KEY` (Linear source),
   and an authenticated `gh` token for GitHub.

## docker-compose.yaml

```yaml
services:
  vanguard-watch:
    build: { context: ., dockerfile: docker/runner.Dockerfile }
    image: vanguard-runner:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # control sibling sandboxes
      - ./target-repo:/work/repo                     # the repo the agent edits (a git clone)
    environment:
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
      LINEAR_API_KEY: ${LINEAR_API_KEY}
      GH_TOKEN: ${GH_TOKEN}                           # for the gh CLI (GitHub source / PRs)
      VANGUARD_MAX_SANDBOXES: "2"                     # cap concurrency to host RAM (NAS: keep low)
    command:
      - watch
      - --label=vanguard
      - --repo=/work/repo
      - --interval=120
      # --source=github            # GitHub Issues instead of Linear
      # --egress                   # confine each sandbox to the allowlist
```

Put the secrets in a `.env` next to the compose file (never commit it). Start:
`docker compose up -d --build`. Logs: `docker compose logs -f vanguard-watch`.

## runner image

See `docker/runner.Dockerfile` — node 24 + the docker CLI + git + gh + the linear CLI + the built
`dist`. It assembles `SKILLS_DIR=/opt/skills` from the linear-cli skill plus this repo's `skills/`
(code-review + simplify), so the review/simplify stages are skill-driven out of the box — no manual
`--skills`. It is the controller, not the sandbox.

Running the factory locally (not via the runner image)? Assemble the same skills dir yourself:

```bash
git clone --depth 1 https://github.com/schpet/linear-cli /tmp/linear-cli
mkdir -p /tmp/vg-skills && cp -r /tmp/linear-cli/skills/. /tmp/vg-skills/ && cp -r ./skills/. /tmp/vg-skills/
# then: vanguard watch --label vanguard --skills /tmp/vg-skills ...
```

## Synology notes

- Container Manager runs the same Docker; the socket is at `/var/run/docker.sock`.
- Many DS models are arm64 — build/pull the sandbox image for that arch, or run on an x86 model.
- NAS RAM is the limit: keep `VANGUARD_MAX_SANDBOXES` at 1–2; each sandbox is ~2 GB.
- DSM may restrict mounting the docker socket from the GUI; deploy via SSH + `docker compose`.

## Hetzner notes

- Identical compose on any CX/CPX/CCX (Docker) instance. For Firecracker (microVM isolation, later)
  you need a Dedicated/AX bare-metal box with `/dev/kvm`; Docker is fine on shared cloud.
- Put the box behind a firewall; with `--egress` the sandboxes already can't reach arbitrary hosts.

## First run (verify before leaving it AFK)

1. `docker compose run --rm vanguard-watch watch --label vanguard --repo /work/repo --once`
   — a single pass: it should claim ready issues, run them, open PRs, and move them to review.
2. Check a sandbox actually started (`docker ps` shows a `vg-*`), a PR opened, and the issue moved
   state/label. Then switch to `up -d` for the polling loop.

## Operational

- Run records + metrics land in `<repo>/.vanguard/runs/` (mounted volume) for the AFK trace.

## Garbage collection

`vanguard gc` reaps stale sandbox containers, prunes git worktree admin entries, and (with
`--remote`) deletes merged remote `vanguard/*` branches. Run it on a timer so resources don't
accumulate over time.

| Flag | Default | Description |
|---|---|---|
| `--repo <path>` | cwd | Git repo to prune worktrees and reap branches in |
| `--max-age-hours <n>` | 6 | Only reap resources older than n hours |
| `--remote <owner/repo>` | — | Also delete merged remote `vanguard/*` branches (needs `gh`) |
| `--dry-run` | — | Report what would be reaped without removing anything |

### cron

**`/etc/cron.d/vanguard-gc`** (system-wide; note the username field required by this format):

```cron
# Run gc every 4 hours. Adjust the repo path and owner/repo slug to match your setup.
0 */4 * * *  root  vanguard gc --remote owner/repo --repo /work/repo
```

Or add to your user crontab with `crontab -e` (no username field in this format):

```cron
0 */4 * * *  vanguard gc --remote owner/repo --repo /work/repo
```

On Synology, use **Task Scheduler** (Control Panel → Task Scheduler → Create → Scheduled Task →
User-defined script) and set the schedule to repeat every 4 hours. Use the same command as the
`crontab -e` form above (no username field).

### systemd timer

Create two unit files in `/etc/systemd/system/`:

**`/etc/systemd/system/vanguard-gc.service`**

```ini
[Unit]
Description=Vanguard garbage collection
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
# Adjust the binary path, owner/repo slug, and repo path. Use the full path (systemd needs it).
ExecStart=/usr/local/bin/vanguard gc --remote owner/repo --repo /work/repo
```

**`/etc/systemd/system/vanguard-gc.timer`**

```ini
[Unit]
Description=Run vanguard gc every 4 hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=4h
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now vanguard-gc.timer
systemctl list-timers vanguard-gc.timer   # verify next trigger
```
