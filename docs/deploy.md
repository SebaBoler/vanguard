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
`dist` + the linear-cli skill (so `--skills` is preset). It is the controller, not the sandbox.

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

- `vanguard gc --remote <owner/repo>` on a timer (cron / Synology Task Scheduler) reaps stale
  sandboxes, worktrees, and merged branches.
- Run records + metrics land in `<repo>/.vanguard/runs/` (mounted volume) for the AFK trace.
