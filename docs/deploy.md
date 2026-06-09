# Deploying the Vanguard watch loop

Run `vanguard watch` always-on so the factory pulls ready Linear or GitHub issues by itself, runs them, and opens PRs. This guide gives three concrete recipes: Synology (step by step, the one that was actually deployed), Hetzner native Docker, and Hetzner with Coolify. All three are the same idea: Docker on Linux, one controller container that starts sibling sandboxes.

## Architecture (docker-out-of-docker)

Vanguard runs as one long-lived **controller** container. It talks to the host Docker daemon through the mounted socket and starts a **sibling** sandbox container (plus optional egress and llm-proxy sidecars) for each run.

```
host docker daemon
 ├─ vanguard-watch        controller: node + docker CLI + git + gh + linear, runs `vanguard watch`
 ├─ vanguard-gc           controller image again, loops: refresh target-repo + gc every 4h
 ├─ vg-<uuid>             per-run sandbox (the agent), started as a sibling
 ├─ vg-llm-<id>           per-run llm-proxy sidecar (holds the Anthropic token; sandbox gets a nonce)
 └─ vg-egr-<id>           per-run egress proxy sidecar (CONNECT allowlist)
```

This works without path tricks because the controller copies the worktree into each sandbox with `docker cp` (it reads the source from its own filesystem) and injects secrets over tmpfs. It never bind-mounts the worktree, so there is no "host path must match" problem. One requirement stands: the **sandbox image must exist on the host daemon** that the controller drives.

## What you need on the host

1. Docker. Synology: Container Manager. Hetzner: `apt install docker.io` or Docker CE.
2. Two images on the host daemon, matching the host CPU architecture: `vanguard-sandbox:latest` and `vanguard-runner:latest`. Build them on the host, or build elsewhere and transfer (see Synology below). Synology and most Hetzner cloud boxes are `x86_64`/`amd64`. An Apple Silicon Mac builds `arm64` by default, which will not run on an amd64 host, so build with `--platform linux/amd64`.
3. A git clone of the target repo the agent edits, mounted into the controller at `/work/repo`.
4. Secrets in the environment: `CLAUDE_CODE_OAUTH_TOKEN` (subscription, the default here), `LINEAR_API_KEY` for the Linear source, and `GH_TOKEN` for git push and PRs.

## Auth: subscription, not API credit

Vanguard reads auth from the environment. `authFromEnv()` prefers `CLAUDE_CODE_OAUTH_TOKEN` (subscription) over `ANTHROPIC_API_KEY` (pay per use). Run on the subscription token: set `CLAUDE_CODE_OAUTH_TOKEN` and leave `ANTHROPIC_API_KEY` unset. With `--llm-proxy` the real token never enters the sandbox at all: a trusted sidecar holds it and the sandbox sees only a per-run nonce.

1Password is a local-dev convenience and is not part of Vanguard. On a server you populate the env some other way. The simplest is a root-only `.env` (chmod 600) next to the compose file.

---

## Recipe A: Synology (step by step)

Validated on DSM 7.3.2, x86_64, 5.6 GB RAM, Container Manager (Docker 24 + compose v2).

### 1. SSH access

Synology allows SSH only for users in the **administrators** group, and key auth needs a home directory.

1. Control Panel, Terminal & SNMP, enable SSH (note the port, e.g. 50022).
2. Control Panel, User & Group: the SSH user must be in **administrators**.
3. Control Panel, User & Group, Advanced, User Home: enable the user home service so `/var/services/homes/<user>` exists.
4. Install your public key and fix permissions (Synology rejects keys when the home or `.ssh` is group-writable):

```bash
cat ~/.ssh/id_ed25519.pub | ssh -p 50022 <user>@<nas-ip> \
  'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~ ~/.ssh && chmod 600 ~/.ssh/authorized_keys'
```

The Docker socket is root-owned, so docker commands need `sudo`. The docker binary is at `/usr/local/bin/docker`.

### 2. Build the images for amd64 and transfer them

Synology cannot build these comfortably, and an Apple Silicon Mac builds the wrong arch. Build amd64 on your dev machine, then stream them over:

```bash
docker buildx build --platform linux/amd64 -t vanguard-sandbox:latest -f docker/Dockerfile --load docker/
docker buildx build --platform linux/amd64 -t vanguard-runner:latest  -f docker/runner.Dockerfile --load .

docker save vanguard-sandbox:latest vanguard-runner:latest | gzip -1 \
  | ssh -p 50022 <user>@<nas-ip> 'cat > /tmp/vg-images.tgz'
ssh -p 50022 <user>@<nas-ip> 'sudo /usr/local/bin/docker load -i /tmp/vg-images.tgz && rm /tmp/vg-images.tgz'
```

### 3. Deploy directory and secrets

```bash
ssh -p 50022 <user>@<nas-ip> 'sudo mkdir -p /volume1/docker/vanguard/target-repo'
```

Write `/volume1/docker/vanguard/.env` (root, chmod 600). Use the subscription token and disable `--cpus` (the Synology kernel has no CPU CFS scheduler, so `docker run --cpus` is fatal):

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
LINEAR_API_KEY=lin_api_...
GH_TOKEN=ghp_...
VANGUARD_SANDBOX_CPUS=0        # required: kernel without CFS scheduler
VANGUARD_SANDBOX_PIDS=0        # silences a harmless pids-limit warning
VANGUARD_SANDBOX_MEMORY_MB=1536
# VANGUARD_VERIFY_CMD=pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
```

### 4. Clone the target repo (the NAS has no git, so use the runner image)

```bash
ssh -p 50022 <user>@<nas-ip> "sudo /usr/local/bin/docker run --rm --entrypoint sh \
  -v /volume1/docker/vanguard/target-repo:/repo vanguard-runner:latest -c \
  'git clone https://github.com/OWNER/REPO.git /repo && \
   git -C /repo config credential.\"https://github.com\".helper \"!gh auth git-credential\"'"
```

The credential helper lets `git push` authenticate with `GH_TOKEN` non-interactively at PR time.

### 5. compose.yaml

Copy `docker/compose.yaml` from this repo to `/volume1/docker/vanguard/compose.yaml`. It defines two services: `vanguard-watch` (the loop) and `vanguard-gc` (self-maintenance). Set `--team`, `--label`, and the `gc --remote OWNER/REPO` slug to match your setup. Keep `VANGUARD_MAX_SANDBOXES: "1"` on a small NAS.

### 6. Start and verify

```bash
ssh -p 50022 <user>@<nas-ip> 'cd /volume1/docker/vanguard && sudo /usr/local/bin/docker compose up -d'
ssh -p 50022 <user>@<nas-ip> 'sudo /usr/local/bin/docker logs -f vanguard-vanguard-watch-1'
```

You should see `watch[linear]: polling every 120s`. To prove the whole chain, create a Linear issue in your team, add the `vanguard` label, and move it to a **Todo** (unstarted) state. The next poll claims it, runs it through the sidecar, and opens a draft PR within a few minutes. Backlog state does not trigger; it must be Todo.

Stop with `sudo /usr/local/bin/docker compose down`.

---

## Recipe B: Hetzner native Docker

A Hetzner CX/CPX/CCX box is simpler than Synology: it is amd64, has git, and its kernel has the CFS scheduler, so no `VANGUARD_SANDBOX_CPUS` override is needed.

```bash
apt update && apt install -y docker.io docker-compose-plugin git
git clone https://github.com/OWNER/REPO.git /opt/vanguard && cd /opt/vanguard
git clone https://github.com/OWNER/REPO.git target-repo   # the repo the agent edits
printf 'CLAUDE_CODE_OAUTH_TOKEN=...\nLINEAR_API_KEY=...\nGH_TOKEN=...\n# VANGUARD_VERIFY_CMD=pnpm install --frozen-lockfile && pnpm typecheck && pnpm test\n' > .env && chmod 600 .env
docker compose -f docker/compose.yaml up -d --build         # builds runner; build the sandbox too
docker build -t vanguard-sandbox:latest docker/             # sandbox image on the same daemon
docker compose -f docker/compose.yaml logs -f vanguard-watch
```

Put the box behind a firewall. With `--llm-proxy` and `--egress` the sandboxes already reach only the allowlist and never hold the LLM token. Firecracker microVM isolation (a later option) needs a Dedicated/AX bare-metal box with `/dev/kvm`; Docker is fine on shared cloud.

---

## Recipe C: Hetzner with Coolify

Coolify deploys a Docker Compose resource straight from a Git repo, which fits Vanguard well. This recipe is the shape to follow; verify it against your Coolify version, because the docker-out-of-docker socket mount is the part Coolify is strict about.

1. In Coolify, add a new resource of type **Docker Compose**, pointed at this repo, with the compose path `docker/compose.yaml`.
2. Set the secrets as **environment variables** in the Coolify UI: `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`, `GH_TOKEN`. Coolify injects them into the compose `${VAR}` references.
3. The controller needs the host Docker socket. Confirm Coolify allows the `/var/run/docker.sock` bind mount in the compose (some hardened setups block host mounts; you may need to allow it for this resource). Without the socket the controller cannot start sandboxes.
4. The **sandbox image must be present on the same Docker host** Coolify uses. Coolify builds `vanguard-runner` from the Dockerfile, but not the sandbox. Build or load `vanguard-sandbox:latest` on that host once (SSH in and `docker build -t vanguard-sandbox:latest docker/`, or `docker load`).
5. Make `target-repo` and `.vanguard/runs` **persistent volumes** in Coolify so the clone and the run records survive redeploys. Seed `target-repo` with a clone the first time (a one-off `docker run` like the Synology step, or an init command).
6. Deploy. Watch the logs in Coolify for the `watch[...]: polling` line.

Caveats: Coolify redeploys may recreate the controller, which is fine (the watch loop is stateless beyond the mounted volumes). The `vanguard-gc` service runs the same as anywhere. If Coolify refuses the socket mount, fall back to Recipe B (plain compose over SSH) on the same Hetzner box; Coolify can still manage other apps alongside it.

---

## Garbage collection and self-maintenance

The `vanguard-gc` service in `docker/compose.yaml` loops every 4 hours: `git -C /work/repo pull --ff-only` (so PRs branch off the latest main instead of a staling clone) and `vanguard gc` (reap stale sandbox containers, prune worktree admin entries, delete merged remote `vanguard/*` branches). Running it in-stack means no DSM Task Scheduler, cron, or systemd timer is needed, and it survives reboots via the restart policy.

If you prefer an external scheduler instead of the in-stack service, `vanguard gc` flags:

| Flag | Default | Description |
|---|---|---|
| `--repo <path>` | cwd | Git repo to prune worktrees and reap branches in |
| `--max-age-hours <n>` | 6 | Only reap resources older than n hours |
| `--remote <owner/repo>` | none | Also delete merged remote `vanguard/*` branches (needs `gh`) |
| `--abandoned` | off | Also delete branches whose PR is closed unmerged |
| `--dry-run` | off | Report what would be reaped without removing anything |

A cron line, for reference: `0 */4 * * * vanguard gc --remote owner/repo --repo /work/repo`. On Synology you would put this in Control Panel, Task Scheduler instead; the in-stack `vanguard-gc` service is simpler and is what this repo ships.

## Operational notes

- Run records and metrics land in `<repo>/.vanguard/runs/` (a mounted volume): per-stage transcript, a git bundle of the changes, the diff, and a `run_complete` metric line. `vanguard stats --repo /work/repo` rolls them up across the fleet.
- RAM is the real cap. Each sandbox is roughly 1.5 to 2 GB plus small sidecars. Keep `VANGUARD_MAX_SANDBOXES` at 1 on a 5 to 6 GB host.
- Updating the deployed code: rebuild `vanguard-runner` for amd64, transfer and load it (Synology) or rebuild on the box (Hetzner), then `docker compose up -d --force-recreate`. The `vanguard-gc` pull keeps the edited repo current on its own.
