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

## Wire format

The UI talks to the hub with `POST /rpc/<command>` (JSON body = the command's camelCase args, `{}` when
none) and listens on `GET /events` (SSE). A success answers `200 {"result": <value>}` (`null` for void
commands, `false` stays `false`); an error answers `400`/`404`/`500 {"error": {"message", "kind"}}` with
`kind` = `bad-request` or `internal`. `apps/desktop/src/transport.ts` unwraps `result` and rejects with
`error.message`, so both sides must keep this envelope.

**`src/hub-wire.ts` is the single source of truth for this envelope, the SSE frame shape, and the hub
marker** — a zero-import module copied verbatim into `apps/desktop/src/hub-wire.ts` by `pnpm gen:wire`
(drift caught by `src/wire.test.ts`). The server (`src/hub/server.ts`, `events.ts`, `static.ts`) and the
browser (`apps/desktop/src/transport.ts`) both call its `encodeResult`/`encodeError`/`decodeResponse`/
`encodeEvent`/`decodeEvent`/`HUB_MARKER` instead of hand-rolling either side of the wire. A reconnecting
SSE client whose `Last-Event-ID` gap exceeds the replay ring gets a `stream-reset` frame instead of a
replay; `transport.ts` resyncs by re-running its snapshot fetches rather than trusting the stream alone.

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

The reusable `implement.yml` and `revise.yml` workflows take an `upload-run-records` input (boolean,
off by default). When a caller passes `upload-run-records: true`, the job uploads `.vanguard/runs/` as
a `vanguard-runs` artifact kept for 14 days, with `**/*.bundle` excluded (git bundles are large and the
reader ignores them). The step runs under the same gate as `persist-metrics`: only once the run step
finished, pass or fail. This repo's own callers (`vanguard-implement.yml`, `vanguard-revise.yml`) opt
in; a client repo adds the input to its thin caller, see `docs/onboarding-another-repo.md` for the
input table and the "off by default, on purpose" notes.

What the artifact may contain, and what keeps it safe to publish: transcripts and `finalText` go
through `redactTokens`; a secret-blocked run, or a stage whose diff the secret scan flags, leaves no
`.diff`, `.bundle` or transcript (`diffOmitted` on the record says why); the scan exempts test paths,
so a credential added under `tests/` or `*.test.ts` is in the diff exactly as it would be in the PR.
Artifacts are downloadable by anyone with read access to the repository — on a public repo, any
signed-in GitHub user.

A `vanguard-runs` artifact is missing when the caller never opted in, when the run step did not reach
`success` or `failure` (blocked actor gate, failed build), or when the run wrote no record at all; the
empty-artifact case does not arise, because `if-no-files-found: ignore` skips the upload instead.

## Resource limits

Mirror `docker/compose.yaml`'s `mem_limit: 1024m` pattern. The hub runs agent sandboxes in the same
process as the HTTP server, so give the container the same RAM headroom, and keep
`VANGUARD_MAX_SANDBOXES=1` on a small host.

## CLI flags

```
vanguard hub [--repo <path>] [--host <addr>] [--port <n>] [--ui-dir <dir>] [--no-open]
```

| Flag | Overrides | Default |
|---|---|---|
| `--repo <path>` | — | cwd; seeded into the project store on startup if it's a git work tree and not already present |
| `--host <addr>` | `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `--port <n>` | `VANGUARD_HUB_PORT` | `7777` (1-65535; an invalid explicit `--port` is a startup error) |
| `--ui-dir <dir>` | `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `--no-open` | — | opens the printed URL in a browser unless passed |

A missing or unbuilt `--ui-dir` fails at startup, naming `pnpm --dir apps/desktop build`
(run `pnpm build:ui`) rather than failing on the first request. Binding a non-loopback host
prints the no-auth warning above and disables `add_project`/`browse_dirs` unless
`VANGUARD_HUB_ALLOW_ADD=1`. `SIGINT`/`SIGTERM` close the listener, every connected SSE client,
and the project file watchers.
