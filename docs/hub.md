# Vanguard Hub

`vanguard hub` serves the same Inspector UI the Tauri desktop app ships (`apps/desktop`) over plain
HTTP/SSE, backed by a real `.vanguard/` directory. Useful when you want the cockpit without installing
a native app, or running it on a server. See `src/hub/*.ts` and `src/cli/hub.ts` for the implementation.

## Quick start

```bash
pnpm build:ui && pnpm hub --repo /path/to/your/repo
```

This opens a browser at the printed URL.

## Modes

- **Local mode** — no authentication, binds `127.0.0.1` by default. Intended for running on your own
  machine, reachable only from itself.
- **Container mode** — binds `0.0.0.0` because Docker port-mapping requires it.

Local mode has no authentication — on a VPS put it behind Tailscale or an authenticating reverse proxy,
never a published port.

## Env vars

| Variable | Default |
|---|---|
| `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `VANGUARD_HUB_PORT` | `7777` |
| `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `VANGUARD_HUB_CONFIG_DIR` | `$XDG_CONFIG_HOME/vanguard-hub` else `~/.config/vanguard-hub` |
| `VANGUARD_HUB_WATCH_POLL` | — |
| `VANGUARD_HUB_WATCH_INTERVAL_MS` | `2000` |
| `VANGUARD_HUB_BROWSE_ROOT` | `$HOME` |
| `VANGUARD_HUB_ALLOW_ADD` | — |

## Coolify / Docker Compose

```yaml
services:
  vanguard-hub:
    build:
      context: .
      dockerfile: docker/hub.Dockerfile
    image: vanguard-hub:latest
    restart: unless-stopped
    mem_limit: 1024m
    ports:
      - "7777:7777"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock # sibling-sandbox execution; see risk note below
      - ./target-repo:/work/repo                  # the repo the hub serves + agent edits
      - vanguard-hub-config:/config                # VANGUARD_HUB_CONFIG_DIR
    environment:
      GH_TOKEN: ${GH_TOKEN}
      VANGUARD_MAX_SANDBOXES: "1"

volumes:
  vanguard-hub-config:
```

Mounting the Docker socket is equivalent to root on the host — a process with access to it can start a
privileged container and read or write anything the host can. Only do this when you trust everything
that runs in this container. If you only ever need read-only access to Docker endpoints, use
[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) in front of the
socket instead of mounting it directly. The [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
is the usual reference for "don't mount the docker socket without justification."

## `gh` auth

The hub shells out to `gh` for the Remote screen (listing GitHub Actions runs) and CI-run import. It
needs a token with `actions:read` (fine-grained PAT) or classic `repo` scope. Run `gh auth login` or set
`GH_TOKEN`.

## CI run import

This repo does not yet upload a `vanguard-runs` artifact — a human must add it. Add a step like this to
one of this repo's workflows, gated behind a `workflow_dispatch` / `workflow_call` input:

```yaml
      - name: Upload run records
        if: ${{ inputs.upload-run-records }}
        uses: actions/upload-artifact@v4
        with:
          name: vanguard-runs
          path: .vanguard/runs
          # exclude *.bundle — git bundles make the artifact large and the reader ignores them anyway
```

This snippet is **not applied** in this repo. It must be added by hand to `.github/workflows/*.yml` by
a human — an agent may never edit workflow files, per `CLAUDE.md`.

## Resource limits

Mirror `docker/compose.yaml`'s `mem_limit: 1024m` pattern. The hub runs agent sandboxes in the same
process as the HTTP server, so give the container the same RAM headroom, and keep
`VANGUARD_MAX_SANDBOXES=1` on a small host.
