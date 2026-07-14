# Subsystem 6 — Custom Providers

**Status:** v3, review-converged (two adversarial rounds — adjudications in §14)
**Depends on:** Subsystem 0 (typed core API), 0.5 (query pipe), 5 (the repo-scoped-listing pattern this spec mirrors)
**Umbrella:** `docs/vanguard-app-vision.md`

---

## 1. Problem

`src/agents/registry.ts` `PROVIDERS` is a hardcoded name→spec table. Anyone whose LLM endpoint is not
one of the six built-ins — the motivating case is a Zai subscription routed through a self-hosted
Anthropic-compatible proxy with its own key and endpoint — has exactly one escape hatch today:
`meridian`, which supports a single operator URL via `MERIDIAN_BASE_URL`, cannot force a default model
(a proxy serving GLM breaks on the CLI's Claude default), is not egress-allowlistable (`meridian.ts:29`
documents an allowlist mechanism that does not exist), and cannot be named, listed, or multiplied.

S6 makes providers user-configurable: a **custom provider** is a named, repo-configured, **keyed**
Anthropic-Messages-compatible endpoint driven by the in-sandbox `claude` CLI — a generalized zai.
The app and CLI list and run them alongside built-ins.

## 2. Credentials invariant + trust model

**The app never stores an LLM key.** A custom provider stores its *endpoint* and the **name of the
host environment variable** holding its key (`keyEnv`). The key itself is read from the environment at
run time, exactly like `ZAI_API_KEY` today. Never in `.vanguard/app.json`, never in the webview,
never in an event. If any part of this design seems to need a stored key, that part is wrong.

**What that invariant does and does not protect.** It protects against at-rest leakage (config files,
backups, screenshots, events). It does **not** make repo config safe to consume from untrusted repos:
`keyEnv` names an arbitrary env var whose value is sent as a Bearer token to the configured `baseUrl`.
That is not a new capability — `.vanguard/` is already trusted-as-code: `flows/lower.ts:36-58`
`resolveRef` dynamically imports and executes repo-authored TS from `.vanguard/`, so running vanguard
against a repo already grants that repo code execution on the host. The S6 trust model is therefore
stated, not invented: **`.vanguard/` config is trusted input; point vanguard only at repos whose
`.vanguard/` you trust.** Consistent with that model, no `keyEnv` deny-list or prefix allowlist is
added (it would be theater beside the ref-import; decision recorded deliberately). Two real boundaries
exist and are load-bearing:
- **Review commands (`review-pr`, `review-mr`, `research`, `spec`) never load customs** (§3 Out).
  These are the commands most likely to run against semi-trusted checkouts; keeping them
  customs-blind is a security property, not just a scope cut — do not "fix" the deferral without
  revisiting this.
- Error messages interpolate env var *names*, never values (existing behavior, preserved).

## 3. Scope

**In:**
- Config shape + validation for custom providers in `.vanguard/app.json` (`customProviders`).
- Core loader + registry resolution so custom names work on the paths that have a repo:
  `vanguard run` / `vanguard watch` / `vanguard doctor` (the checker must be able to check what
  watch runs), watch's embedded spec generator, sidecar `createRun` (desktop), preflight,
  cross-provider pairing rules. `doctor-prs`/`doctor-mrs` keep the closed gate: they check
  `watch-prs`/`watch-mrs`, which are REVIEW loops — and customs never review (§2). (Reconciled
  after PR #340 review round 1: an earlier draft of this line listed them among the relaxed
  shapes, which contradicted the review-boundary rule; the code's narrower gate is correct.)
- Direct mode (default and `--egress`). Under `--egress` the used custom's host is added to the
  enclave allowlist, computed at dispatch (§7).
- Sidecar `listProviders` method (query pipe) + desktop surfaces: NewRunForm dropdown merge,
  Settings custom-providers editor, TS + Rust `AppConfig` mirrors.
- The Rust `appconfig.rs` field ships in **PR A** as a raw `serde_json::Value` passthrough (§8) —
  a *typed* Rust struct is not a dumb pipe (it strips unknown entry keys on save, and one
  type-mismatched entry collapses the whole config read to `Default`, erasing the file on the next
  save). Without the field, any Settings save erases hand-written `customProviders`
  (`appconfig.rs:42-46` serializes only known struct fields); that window must not exist while PR A
  is the only authoring path.
- Generalizing the stale zai literals on the run path: `preflight.ts:226` llm-auth check (via
  `anthropicTransportKeyEnv`, fixing openrouter/meridian too) and `runners/spec.ts:176` — the haiku
  override must not apply to providers that force their own model (a GLM endpoint asked for `haiku`
  fails). The registry exports a named helper for this: `forcedProviderModel(name, customs):
  string | undefined` (a `forcedModel` field on `ProviderSpec` — set for zai and synthesized
  customs-with-`model`; the provider classes keep their own internal defaults).
- Rejecting flow-stage pins to transport-owning providers in `flows/lower.ts` (§6 gate 4) — fixes a
  latent silent-wrong-endpoint trap live for `provider = "zai"` stage pins today.

**Out (deferred, each with its trigger):**
- **Keyless custom providers (`keyEnv` optional).** Cut in round 2: the motivating case is keyed;
  keyless-single-URL is exactly what meridian already does; and keyless was the only part of the
  registry diff that *changed* semantics (`providerSecrets` const-secrets branch,
  `anthropicTransportKeyEnv` no longer meaning "owns transport") instead of adding to them — it also
  silently broke the generalized preflight llm-auth check (a keyless custom would demand an Anthropic
  credential it never consumes). With `keyEnv` required, a synthesized custom is a pure zai clone and
  the registry change is purely additive. Escape hatch needing zero code: export a dummy-valued env
  var (the CLI only needs non-empty — the meridian placeholder property). Trigger + counterpoint
  recorded: a keyless custom would strictly subsume meridian (named, forced model, egress-listed);
  if meridian is ever to be deprecated, implement keyless then, with the preflight fallthrough
  `!needsAnthropicAuth ⇒ pass`.
- **`--llm-proxy` for customs.** The proxy sidecar's `UPSTREAMS` table, secret-file protocol, and
  server (`https://<host>:443` hardcoded) are all closed; parameterizing them is real surgery. v1
  customs are **direct-only**, rejected at dispatch *before sandbox spin-up* (§6 gate 2). Security
  posture equals running zai without `--llm-proxy`, today's default. Trigger: someone wants a custom
  endpoint with the key held out of the sandbox.
- **Non-Anthropic transports.** Customs drive the `claude` CLI against Anthropic-Messages-compatible
  endpoints only. Codex already has `OPENAI_BASE_URL` passthrough. Trigger: a real
  second-transport case.
- **Customs on review commands and as `--review-provider`.** Built-in-only gates stay (also a
  security boundary — §2). A custom reviewer would additionally always collide with the implementer
  on the 'anthropic' transport. Trigger: demand + a trust-model decision.
- **Flow-stage transport rerouting.** Stage pins to transport-owning providers are *rejected* (§6
  gate 4), not implemented — per-stage sandbox transport env is real work. Trigger: demand.
- **Meridian egress retrofit** (its host via the same allowlist threading). Trigger: first
  meridian + `--egress` user.
- **Custom-provider session resume.** `core/vanguard.ts:21` `CLAUDE_SESSION_PROVIDERS` doesn't
  include openrouter/meridian either; customs match that behavior. Documented, not changed.

## 4. Config shape

In `.vanguard/app.json`:

```json
{
  "customProviders": [
    {
      "name": "my-proxy",
      "baseUrl": "https://llm.example.com/api",
      "keyEnv": "MY_PROXY_API_KEY",
      "model": "glm-5.2"
    }
  ]
}
```

| field | req | rules |
|---|---|---|
| `name` | yes | `^[a-z0-9][a-z0-9._-]*$` (the flow-name grammar); not a built-in (`PROVIDER_NAMES`); unique within the array |
| `baseUrl` | yes | absolute `http:`/`https:` URL (becomes `ANTHROPIC_BASE_URL` verbatim) |
| `keyEnv` | yes | `^[A-Za-z_][A-Za-z0-9_]*$`; host env var holding the key (the value is read at dispatch, never stored) |
| `model` | no | non-empty string; forced default model (zai pattern: `input.model ?? model`) for endpoints that don't serve the CLI's Claude default |

No `label` field (flows needed one because file ≠ name; a provider's name is its display name).

Unknown keys inside an entry are a validation error (never-silent-drop, the flow-doc rule). Unknown
keys elsewhere in `app.json` are none of core's business (it reads exactly one key).

**One validity predicate.** `customProviderError(entry, index, seen)` in the loader is the single
source of truth for this table. Sidecar and Settings validation call it (directly or via the loader);
the Settings UI may mirror the grammar regexes for inline feedback (the `FLOW_NAME_RE` precedent) but
the predicate decides.

## 5. Core loader — `src/agents/custom.ts`

One loader, lenient at the edges, loud at resolution:

```ts
export interface CustomProviderSpec { name: string; baseUrl: string; keyEnv: string; model?: string }

/** One configured entry: healthy (spec set) or broken (error set). `index` = array position.
 *  Invariant: `error` absent ⇔ the entry is resolvable/runnable. */
export interface CustomProviderEntry { index: number; name?: string; error?: string; spec?: CustomProviderSpec }

/** Read `<repoPath>/.vanguard/app.json` `customProviders`.
 *  Missing file, missing key, `null`, or `[]` ⇒ []  (the desktop's emit-all serde style writes
 *  `"customProviders": null` for absent — null MUST behave as absent).
 *  Unparseable file JSON, or a non-array `customProviders` value ⇒ a single error-flagged
 *  pseudo-entry (index -1) — NEVER a throw: a broken config must not break built-in-provider runs.
 *  Structurally invalid entries come back error-flagged (index + field + rule in `error`). */
export async function loadCustomProviders(repoPath: string): Promise<CustomProviderEntry[]>;
```

- Resolution (§6) of a custom **name** against these entries throws `AgentError` quoting the entry's
  `error` — a typo'd `baseUrl` fails loudly *when that provider is used*, while `vanguard run
  --provider claude` in the same repo is untouched (frozen-contract AC 11).
- Duplicate names: second entry error-flagged (index named). Name-set membership via `Object.hasOwn`
  (the S5 prototype-key lesson).
- The loader never checks `process.env[keyEnv]` — key presence is a dispatch-time fail-fast
  (`providerSecrets` / `agentAuthFromEnv`), not config validity: listing on a machine without the key
  is fine; running names the missing var.
- `listProviders` (§8) serializes these entries minus `spec` — same list, no second loader.

## 6. Registry resolution — how a string becomes a provider

`ProviderChoice` is the artery (every runner's deps extend it). It gains the loaded customs and its
names widen:

```ts
export interface ProviderChoice {
  provider?: string;        // was ProviderName — see the widening inventory below
  reviewProvider?: string;
  /** Loaded ONCE per entry point from the TARGET repo (cmd.repoPath / params.repoPath — NOT
   *  process.cwd(); --repo exists) and carried with the choice. Registry functions never do IO. */
  customProviders?: CustomProviderEntry[];
}
```

- **`ProviderName` stays** `keyof typeof PROVIDERS` = "built-in". `isProviderName` unchanged.
- Module-private `spec(name)` becomes `resolveSpec(name, customs?)`: built-in wins, else a
  `ProviderSpec` synthesized from a healthy custom entry, else `AgentError` — broken entry ⇒ its
  recorded `error`; unknown name ⇒ list of built-ins + healthy custom names.
- Registry functions that resolve names gain the optional customs and pass them down:
  `makeProvider`, `requiresApiKey`, `anthropicTransportKeyEnv`, `providerSecrets`, plus the new
  `forcedProviderModel` (§3); `needsAnthropicAuth`, `validateProviderChoice`, `selectAgents` read
  them off the choice itself. `agentAuthFromEnv` passes `choice.customProviders` through.
  `anthropicTransportKeyEnv(name, customs) !== undefined` keeps meaning "owns the Anthropic
  transport" (all customs are keyed — §3).

### Synthesized spec (a generalized zai)

- `factory: () => new CustomProvider(spec)` — one ~25-line class in `custom.ts` wrapping
  `runClaudeCli(input, buildClaudeArgs)`; forces `model: input.model ?? spec.model` when `model` set,
  verbatim args otherwise. `AgentProvider.name` = `custom:<name>` (grammar forbids `:` — collision
  impossible). Two *behavioral* name consumers exist and both default correctly, pinned by tests:
  `skill-registry.ts:20-24` `providerFamily` → 'claude' family (right — customs drive the claude
  CLI); `vanguard.ts:315` `CLAUDE_SESSION_PROVIDERS` miss → no session capture (§3 deferral).
- `transport: 'anthropic'`, `ownsAnthropicTransport: true` (Anthropic authSecrets suppression —
  existing mechanism, holds on both CLI and sidecar paths via `selectAgents`), `directOnly: true`,
  `forcedModel: spec.model`.
- `key: { hostEnv: [spec.keyEnv], toSandboxSecrets: k => ({ ANTHROPIC_BASE_URL: spec.baseUrl,
  ANTHROPIC_AUTH_TOKEN: k }) }` — the zai shape verbatim; every existing mechanism
  (`providerSecrets` fail-fast, `agentAuthFromEnv` api-mode carry, suppression, collision check,
  `directOnly` rejection) rides untouched. No `passthroughEnv` (a stray env bleed-in is exactly what
  we don't want).

### Entry points (customs loaded exactly once each)

| entry | repoPath | placement |
|---|---|---|
| CLI `run` / `watch` / `doctor*` | `cmd.repoPath` | **first statements of the dispatch fn**: (1) load customs, (2) **re-run `validateProviderChoice(choice, { proxyMode })` and the §7 http+egress guard immediately** — before `--gc-before`, `requireAuth`, preflight, and `startSandboxContext`. Do NOT rely on `selectAgents`' internal validation: it runs after the enclave (and, under `--llm-proxy`, after the proxy sidecar has been handed the custom's key with an api.anthropic.com upstream — the early re-validate is what prevents that). Watch: loaded once per process — customs and the enclave allowlist are a watch-start snapshot; restart to pick up edits (do not reload per poll and diverge from the fixed allowlist) |
| sidecar `createRun` dep | `params.repoPath` | first statements, with `assertFlowResolvable`, before `beginRun()`. Resolution/validation failures wrap in `BadRequestError` (the classifier maps only `BadRequestError|FlowError` to `bad-request`; a bare `AgentError` would surface `internal`) |
| review commands / standalone `spec` | — | never load customs (§2, §3) |

### Threading inventory (the widening's real cost — PR A's honest scope)

`string`→`ProviderName` seams that must widen (verified compile-breaks otherwise):
`args.ts` command shapes (~10 fields) + the post-gate narrows (:432);
`pipeline.ts:617-619` `ReviewPipelineDeps`; `sandbox-context.ts:40` `SandboxContextOptions.provider`
(behaviorally safe in direct mode — returns before reading it; the llm-proxy branch is unreachable
for customs once the entry-point re-validate rejects them first); `github.ts:84`/`gitlab.ts:116`/
`linear.ts:109` deps-from-env params (these also gain customs — they build fresh choice literals
internally); `sidecar/deps.ts:18-22` `toProvider`; `preflight.ts:201-206` `collectProviders`'
`name is ProviderName` predicate.

**`pickRunOptions` (source-adapter.ts:92-111) copies field-by-field and MUST gain
`customProviders`** — and the dispatch must first put customs ON its input
(`pickRunOptions({ ...cmd, customProviders })` or set before the call); adding the copy line alone
silently no-ops. Mutation seam: a stub-adapter test through `runSourcedIssue` asserts `selectAgents`
throws unknown-name when the line is dropped.

Gate 4's path also threads customs: `resolveBaseStages` (source-adapter.ts:233-243) →
`resolveRepoFlow` (flows/repo.ts) → `lowerFlow` (lower.ts:15) → `applyOverrides` →
`resolveProvider` — three more signatures, listed here so the inventory stays honest.

Watch's spec-generator deps (`watch.ts:103,182,274`) thread customs the same way (the embedded
generator runs with the watch provider; the standalone `spec` command does not load customs).

`runPreflight` loads customs from `cmd.repoPath` (it is async) and passes them to all three
resolving checks: `collectProviders`/`requiresApiKey`, `providerSecrets`, `validateProviderChoice` —
not just the llm-auth line.

### The gates (S5 precedent: shape-check sync, resolve at dispatch)

1. **`args.ts:426` name gate** — for `run`/`watch`/`doctor*` shapes, relaxes to the name grammar
   (accepts every built-in). Parse keeps rejecting grammar-invalid names (`--provider CLAUDE`) with
   the built-in list. Other commands keep the closed-set gate; `--review-provider` keeps it
   everywhere.
2. **`args.ts:497-505` parse-time `validateProviderChoice`** — the round-1-missed fourth gate: it
   dereferences `spec(name)` and would TypeError on customs. For the relaxed shapes it is **skipped
   when `provider` is non-built-in** (reviewProvider cannot be non-built-in, per gate 1) and re-run
   at the dispatch entry point (see table above — before any sandbox cost). Built-in pairs keep
   failing at parse (`args.test.ts:154` unaffected). Consequence: for custom names the `--llm-proxy`
   directOnly rejection and transport-collision errors move parse→dispatch; dispatch failures
   surface through the existing `AgentError` path (same presentation as a missing key today; exit
   code stays 1).
3. **`sidecar.ts:119` `validateCreateRun`** — provider check relaxes to non-blank string (the flow
   precedent, sidecar.ts:126-130); the dep's first-statement resolution classifies unknown/broken as
   `bad-request` before any run record or sandbox cost. (`sidecar.test.ts:58` — intentional churn,
   §11.)
4. **`flows/lower.ts:79-82` `resolveProvider`** — gains customs for name resolution and error
   listings, but **rejects any stage pin to a transport-owning provider** (customs, zai, openrouter,
   meridian) with a named error: a stage pin only swaps the agent object (pipeline.ts:242); sandbox
   transport env is fixed per-run by `selectAgents`, so such a pin would silently run against the
   run provider's endpoint with the pinned provider's forced model. Live trap for `provider = "zai"`
   today; erroring loudly is the fix. Cross-slot pins (codex/cursor) stay allowed (their CLIs fail
   loudly on missing keys — pre-existing, documented limitation). Error message keeps the
   `unknown provider "…"`-style prefix conventions of lower.ts (existing tests pin the prefix).
   On the CLI path this error fires at flow-lowering (pre-stage, inside the run); on the desktop
   path lowering happens mid-run after `beginRun`, so it surfaces as a run failure event, not an
   RPC `bad-request` — stated here so nobody "fixes" the classification later.

## 7. Sandbox + egress

- **Direct, no `--egress`:** zero sandbox changes — secrets injection exactly like zai.
- **Direct + `--egress` (and every desktop run — `deps.ts:87` hardwires `egress: true`):** the
  enclave is created at dispatch, *before* `selectAgents` runs. So: `SandboxContextOptions` gains
  `extraEgressHosts?: string[]`, computed **at each entry point** by a pure helper
  `customEgressHosts(choice)` (hostname of the resolved custom's `baseUrl`; ≤1 host in v1 since only
  `provider` can be custom) and appended by `startSandboxContext` to the allowlist it passes
  `startEgressEnclave` (materializing DEFAULT_EGRESS_ALLOWLIST + extras in the plain-egress branch
  that today passes none). No enclave changes (`opts.allowlist` exists — egress-network.ts:30).
- **`http:` baseUrl + `--egress`: fail-fast in the entry-point validate block (§6)** — the enclave
  proxy is CONNECT-only (egress-proxy-server.mjs 405s non-CONNECT); a plain-HTTP endpoint cannot
  traverse it. Since the desktop is always-egress, **an `http:` custom is CLI-only (no `--egress`)**:
  the createRun dep rejects it `bad-request` with a message saying exactly that (AC 4b). `http:`
  without `--egress` works (LAN proxies are the motivating case).
- Non-443 `https:` ports work under `--egress` (CONNECT carries host:port; `isAllowed` matches host
  only) — pinned by a unit test on the computed allowlist.
- **`--llm-proxy`:** rejected via `directOnly` in the entry-point validate block, before any
  container exists (§6).

## 8. Sidecar protocol + desktop

Mirrors S5's `listFlows`:

- **`listProviders { repoPath }` → `{ providers: RepoProviderInfo[] }`** where `RepoProviderInfo` =
  `{ index: number; name?: string; error?: string }` (`error` absent ⇔ runnable;
  whole-file-unreadable ⇒ single `{ index: -1, error }` pseudo-entry; no `baseUrl` on the wire —
  nothing consumes it). New method on `Pipe::Query`, `Bound::Timed`, absolute-`repoPath` validation
  (`requireAbsoluteRepoPath`). Customs only — built-ins stay on the pure, session-cached
  `capabilities()`; union client-side.
- **`capabilities()` byte-identical.**
- **Rust (PR A):** `appconfig.rs` gains `custom_providers: Option<serde_json::Value>` — raw
  passthrough, round-trips arbitrary entry content (key order may normalize; content never mutates).
  Deliberately NOT a typed Vec: typed serde would strip unknown entry keys on save and collapse the
  whole config to `Default` on one type-mismatched entry (§3). Rust never validates or interprets it
  (the loader is the predicate; the editor edits it in TS).
- **Rust (PR B):** `api_list_providers` via the `flow_request`-style helper; register in `lib.rs`.
- **`vanguard-output.d.ts` (PR B):** `AppConfig.customProviders?: { name: string; baseUrl: string;
  keyEnv: string; model?: string }[] | null` (nullable — Rust None serializes as null; entries may
  carry unknown keys at runtime, the type is the intended shape).
- **ipc.ts (PR B):** `RepoProviderInfo` mirror + `apiListProviders(repoPath)` — no caching (a
  provider saved in Settings must be runnable in NewRunForm immediately).
- **NewRunForm:** options = pure `providerOptionsFrom(capabilities, repoProviders)` (built-ins
  first, healthy customs after, first-wins seen-set — `flowOptionsFrom` verbatim; error-flagged
  entries excluded from the dropdown, S5 precedent — errors are visible where they're editable,
  Settings), fetched fresh per mount; `'error'` state degrades to built-ins-only with an inline
  note; form never hidden.
- **Settings:** the hardcoded `PROVIDERS` array (Settings.tsx:9) is replaced by capabilities +
  healthy repo customs (from `apiListProviders` on mount, same as NewRunForm; unsaved rows appear
  after save) **for the provider dropdown only; the reviewProvider dropdown stays built-ins-only**
  (no surface accepts a custom reviewer — §3). A dangling `cfg.provider` (naming a deleted/broken
  custom) renders as a flagged option (`my-proxy (not configured)`) so display matches storage. New
  "Custom providers" section: add/remove/edit rows for `name`/`baseUrl`/`keyEnv`/`model` through the
  existing `writeAppConfig` path; rows failing the §4 rules block save with inline messages.
  **`keyEnv` is an env var *name*; the UI labels it so and never offers a value field** (the webview
  cannot read host env — verified, and kept that way).
- **Settings data-safety guards (PR B; S5 async-loss class, pre-empted):** (a) Save disabled until
  the initial `read_app_config` resolves — today `useAppConfig` seeds `{}` (hooks.ts:36) and
  swallows read failures, so an early Save writes `{}` over the file; (b) the Settings read path
  distinguishes *unreadable* app.json (error surfaced, Save blocked) from *absent* (defaults) —
  scoped to the Settings/`read_app_config` command only; the passive consumers of `appconfig::read`
  (projects.rs, tasks.rs, sidecar.rs chat/task paths) keep collapse-to-default. Both guards protect
  all Settings fields, not just customs.

## 9. PR delivery

- **PR A — core + protocol + the Rust passthrough field:** loader + predicate, registry resolution +
  widening inventory, CLI relaxed-shape gates + dispatch load-validate blocks + preflight, egress
  `extraEgressHosts`, lower.ts gate 4, `forcedProviderModel` + spec-model generalization, sidecar
  `listProviders` + `createRun` relax + dep fail-fast, `appconfig.rs` Value field. Live-verified
  (§13) before merge.
- **PR B — desktop:** `api_list_providers` + ipc + TS mirrors + NewRunForm merge + Settings section
  + data-safety guards.

## 10. Acceptance criteria

1. Repo with the §4 example: `vanguard run --provider my-proxy …` dispatches with
   `ANTHROPIC_BASE_URL=https://llm.example.com/api`, `ANTHROPIC_AUTH_TOKEN=$MY_PROXY_API_KEY`,
   default model `glm-5.2`; Anthropic authSecrets suppressed. Same via `--repo <path>` from another
   cwd (customs come from the target repo).
2. `MY_PROXY_API_KEY` unset: fail-fast at dispatch naming `MY_PROXY_API_KEY`, before sandbox
   spin-up.
3. `--provider my-proxy --llm-proxy`: direct-only error naming `my-proxy` — at dispatch, **before
   any container is created** (no enclave, no proxy sidecar, the key never leaves the host env).
4. (a) `--provider my-proxy --egress`, `https:` baseUrl: computed enclave allowlist includes the
   host (unit test; live container check only if a harness exists — §12); non-443 port works.
   (b) `http:` baseUrl + `--egress` (CLI) and desktop createRun (always-egress): named fail-fast
   before any container; CLI without `--egress`: runs.
5. `--provider bogus` (grammar-valid): dispatch error listing built-ins + healthy custom names;
   `--provider BOGUS` (grammar-invalid): parse error listing built-ins. Both exit 1.
6. Commands outside the relaxed shapes (review-pr, review-mr, research, spec): `--provider my-proxy`
   rejected at parse with the built-in list (unchanged; pinned). `vanguard doctor --provider
   my-proxy` works (preflight reports on the custom).
7. Sidecar: `listProviders` returns healthy + error-flagged entries (and the index-−1 pseudo-entry
   for unparseable files); `createRun` custom name resolves; unknown name → `bad-request` before
   `beginRun` (no run record); broken entry → `bad-request` quoting its recorded error.
8. Loader: unknown entry key, bad name grammar, built-in collision, dup name, non-URL baseUrl,
   missing keyEnv → error-flagged entries (never a throw); `customProviders: null` / missing / `[]`
   / missing file → `[]`. A repo with a *broken* customs array still runs `--provider claude`
   identically (frozen-contract).
9. `--provider my-proxy --review-provider claude`: transport-collision error at dispatch, before
   sandbox spin-up.
10. Flow with `stage { provider = "my-proxy" }` (or `"zai"`): rejection naming the stage and why
    transport-owning pins are rejected (CLI: at lowering; desktop: surfaces as the run's failure —
    stated in §6 gate 4).
11. Byte-identical: `capabilities()`; every built-in CLI invocation's parse result (snapshot);
    `vanguard run --provider claude` behavior in a repo with healthy, broken, or absent customs.
12. Desktop: NewRunForm lists built-ins + healthy customs fresh per mount; listProviders failure →
    built-ins only + note. Rust field round-trips arbitrary `customProviders` content including
    unknown entry keys (regression test); a Settings save of unrelated fields preserves hand-written
    customs **for saves after the config read completed — from PR A on; the pre-read race closes in
    PR B** (guard (a)). Save disabled until config read resolves; unreadable app.json surfaces an
    error instead of silently defaulting (PR B).
13. `providerFamily('custom:x')` → claude family (pinned); custom runs produce no session-resume
    record (§3, pinned or asserted in the live probe).

## 11. Intentional test churn

- `args.test.ts:143-147` — parse-time `Unknown provider "gpt"` for run: moves to dispatch with the
  built-ins+customs message (grammar-valid name). Update, don't "fix".
- `sidecar.test.ts:58` — "rejects unknown provider as bad-request without invoking createRun": the
  dep is now invoked (resolution is its first statement); assert bad-request + no `beginRun` instead.
- `NewRunForm.test.tsx:7-9` (PR B) — the ipc mock gains `apiListProviders` or every render test
  throws.
- `lower.test.ts:61-63` pins `/unknown provider "bogus"/` — the customs-aware message must keep that
  prefix.

## 12. Test plan

- Unit: predicate table (every §4 rule, prototype-key names, dup index, unknown-key rejection,
  null/missing/non-array file shapes); resolution (synthesized spec shape, model forcing +
  `forcedProviderModel`, broken-entry error quoting, unknown-name listing); `customEgressHosts`
  (URL → hostname, port stripped, built-in/absent → empty); gates (grammar relax on the §6 shapes vs
  closed elsewhere, parse-validate skip for non-built-in provider + dispatch re-validate placement,
  sidecar relax + dep ordering); preflight with customs (all three checks; missing-key reported);
  lower.ts transport-owning pin rejection (customs AND zai); `providerFamily` default.
- Mutation tests (watch-it-fail): `Object.hasOwn`→`in`; drop the http+egress guard; drop authSecrets
  suppression for customs; reorder dep resolution after `beginRun`; drop `pickRunOptions`'
  `customProviders` line (stub-adapter test through `runSourcedIssue` must then see `selectAgents`
  throw); move the dispatch re-validate after `startSandboxContext` (the llm-proxy AC 3 test must
  then fail).
- Live probes: (a) local Anthropic-Messages-compatible stub server (asserts path, auth header,
  model; returns a minimal Messages response); run a keyed custom against it through the real
  dispatch path (sandboxed if feasible; minimum bar: assert computed sandbox secrets + allowlist
  from a real config file, plus the built sidecar over stdio for listProviders happy/broken/absent
  and createRun fail-fast timing). (b) desktop Settings round-trip against the real Rust binary
  (cargo test: read/write cycle preserving customs incl. unknown entry keys).
- Frozen-contract: arg-parse snapshot for built-in provider invocations across all commands.

## 13. Verification against reality

The §12(a) stub probe is mandatory before PR A merges: it proves `ANTHROPIC_BASE_URL` + token +
model forcing end-to-end against a real HTTP listener, not a mock of our own emitter. The `--repo`
AC (1) runs from a scratch directory. Sidecar probes drive the built `dist/` binary over stdio
(S5 style).

## 14. Review adjudication

### Round 1 (4 lenses, 30 findings)

Adopted: egress dataflow inversion (blocking — dispatch-computed `extraEgressHosts` replaces the
impossible `SelectedAgents` threading); fourth gate (parse-time `validateProviderChoice`);
keyless-custom `ProviderKeySpec` misfit; choice threading inventory incl. `pickRunOptions` and
deps-from-env rebuild sites; `cmd.repoPath` not cwd; loader lenient-edges redesign +
`customProviders: null`; broken-config must not break built-in runs; flow-stage transport-owning pin
rejection (fixes latent zai trap); Rust field moved to PR A; desktop-always-egress consequence (http
customs CLI-only); preflight full threading; `BadRequestError` wrapping; `spec.ts:176`
generalization; watch snapshot semantics; Settings reviewProvider stays built-in-only;
`RepoProviderInfo` `index` + crisp invariant; TS AppConfig mirror (nullable); intentional test churn;
Settings async-loss guards; trust-model statement + review-commands-as-boundary; citation fixes.

Rejected with rationale: **keyEnv deny-list / prefix allowlist** — `.vanguard/` flow refs already
execute repo TS on the host (lower.ts:36-58); the real boundary is which repos you point vanguard at
plus customs-blind review commands (§2). **`label` field** — YAGNI. **Allowlisting all configured
customs' hosts** — moot once gate 4 rejects transport-owning pins; used-only is tighter.

### Round 2 (3 lenses, ~20 findings)

Adopted: **keyless cut from v1** (the one semantic-not-additive registry change; broke generalized
preflight; meridian covers keyless; dummy-env escape hatch — §3 Out with trigger + counterpoint);
**Rust field as `serde_json::Value`** (blocking — typed serde strips unknown entry keys and
collapses the config to Default on one type mismatch, defeating the very reason the field moved to
PR A); **named dispatch re-validate site** (first statements after load, before requireAuth /
startSandboxContext — also prevents handing the custom's key to an Anthropic-upstream proxy sidecar
under `--llm-proxy`); doctor shapes join the relax (the checker must check what watch runs); gate-4
threading seams (resolveBaseStages → resolveRepoFlow → lowerFlow) + desktop error-classification
statement; `pickRunOptions` augmentation site + named mutation seam; `forcedProviderModel` helper
(the spec-model fix needs a queryable mechanism); `providerFamily`/`CLAUDE_SESSION_PROVIDERS`
"logs-only" claim corrected to "behavioral, defaults correct, pinned"; AC 12 PR A/PR B qualification
(pre-read race closes in PR B); live container check demoted to if-feasible; wire `baseUrl` dropped
(no consumer); Settings dangling-provider rendering + dropdown data source pinned; PR B test churn
(NewRunForm mock, lower.test message prefix); guard (b) scoped to the Settings read path only.

Verified sound in round 2 (anti-findings): PR A Rust field alone does prevent Settings erasure on
the normal path (the TS side passes the whole runtime object through read→save — unknown fields
survive; the d.ts mirror is compile-time only); keyed-custom auth lands nowhere unintended in
direct mode; Fleet needs no `--repo` (spawns with cwd = project); PR A is reviewable as one PR
(~18 files, bulk mechanical widening — S5 PR A was bigger and merged fine).
