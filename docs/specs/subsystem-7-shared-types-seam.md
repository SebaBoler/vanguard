# Subsystem 7 — Shared-Types Seam (wire contract codegen)

**Status:** v2, review-converged (one adversarial round, 2 lenses, 17 findings — adjudication §8)
**Problem class:** every subsystem since S0 has added hand-mirrors between core and the desktop;
S5 and S6 reviews both flagged mirror drift. This kills the TS↔TS mirror class.

---

## 1. Reality (mapped, verified)

The repo is **two disjoint pnpm installs** — no workspace, desktop has its own lockfile, root
package has no `exports`, different TypeScript majors (root 6.x, desktop 5.9). "No import path
into core" is literal. CI builds/tests root only; the desktop compile is local-only.

**TS↔TS mirrors (Rust passes all of these through as opaque `serde_json::Value`):**
- `RunEvent` — events.ts:6 vs typedRunReducer.ts:4
- `MAX_BODY_BYTES` / `MAX_TITLE_BYTES` — create.ts:30/38 vs docTask.ts:9/11
- `TRANSPORTS` — capabilities.ts:27 vs docTask.ts:22 (missed by the draft; found in review)
- `FLOW_NAME_RE` — flows/repo.ts:33 vs flowEditorReducer.ts:135; **the same grammar** is
  re-declared module-private as `NAME_RE` in custom.ts:39 (its own comment: "one grammar")
- Built-in provider list — registry PROVIDER_NAMES vs customProviders.ts:6
- Custom-provider grammar (`KEY_ENV_RE`, allowed entry keys) — custom.ts:40-41 vs
  customProviders.ts:11-13
- `Capabilities` — capabilities.ts vs ipc.ts:100 (ipc inlines what core calls `FlowInfo`; the
  named `FlowInfo`/`CreateRunResult` don't exist desktop-side today — adoption *introduces* them)
- `CreateRunParams` — sidecar.ts:15 vs ipc.ts:109; create-run result inline at ipc.ts:141
- `StageOverrides`/`StageDecl`/`LoopDecl`/`FlowDoc` — flows/types.ts vs ipc.ts:187-206
  (`StageOverrides.effort` is `ReasoningEffort` from core/types.ts:5 — see §3)
- `RepoFlowInfo` — repo.ts:23 vs ipc.ts:214; `RepoProviderInfo` — sidecar.ts:58 vs ipc.ts:227
- `CompleteRequest`/`CompleteResponse` — api/complete.ts:2-13 vs ipc.ts:152-160 (desktop
  deliberately drops `baseUrl` — a security subset, not a drift accident)
- `Finding` + severity/kind enums — structured/findings.ts:4-9 (zod) vs
  components/findings.ts:1-9 — a real adversary-output contract with NO sync header at all
- `CreatedTask` — tasks/create.ts:14 vs the inline `{ id; url }` at ipc.ts:171

**TS↔Rust mirrors (`vanguard-output.d.ts` vs src-tauri serde structs): OUT OF SCOPE.** Their peer
is Rust, which a TS seam cannot pin. S9 shrinks this set (board `Task` becomes a wire type); the
rest keeps the existing header discipline. Settings' custom-provider `Row` type stays
`AppConfig`-derived (it must track the serde round-trip incl. unknown-key passthrough) — wire
does NOT export a Settings row shape.

## 2. Decision — one wire module in core, copied by codegen, drift-guarded in root CI

Rejected alternatives:
- **Type-only tsconfig alias:** structurally insufficient, not merely fragile — the inventory is
  majority *runtime values* the webview needs (MAX_*, the regexes, PROVIDERS, TRANSPORTS); a
  type-only alias cannot carry them and the value mirrors would stand.
- **Full alias/import of the single wire file** (types + values; safe once wire has zero
  imports): genuinely the least machinery, but rejected on two grounds. (a) Self-containment:
  the desktop package stops being buildable from its own directory (out-of-package tsconfig
  include, vite `server.fs.allow`, watch scope; couples against any future desktop extraction).
  (b) **Failure locality:** root CI cannot compile the desktop (two installs, and CI is
  root-only); an aliased wire edit that breaks desktop compile fails in the package CI never
  builds — silently. Codegen drift fails **root** CI naming the fix.
- **Package dependency (`link:../..` + exports):** requires root `pnpm build` before every
  desktop typecheck, crosses the TS 6/5.9 boundary, and the value modules import node-only code.
- **Chosen: codegen + drift guard** — the `gen-flow-b.ts` + `roundtrip.test.ts:23` pattern
  already in this repo. Covers types AND values, fits the two-install split, lands entirely in
  existing CI gates.

## 3. Shape

### `src/wire.ts` — the single source of truth (NEW, core)

One file, **zero imports** (static AND dynamic — the guard test asserts no import/export-from
specifiers, no `import(`, no `require(` in the file; a direct single-file check, not a graph
walk). **Syntax ceiling:** interfaces, type aliases, literal unions, and `const` literals only —
nothing newer than the desktop's TS 5.9 (the drift guard proves byte-equality, not
compilability; the ceiling is what keeps a root-authored edit compiling under the desktop
compiler, and AC 3's desktop-build check is local-only until a desktop CI job exists).

Types: `ReasoningEffort` (moves here from core/types.ts:5, which re-exports — public API via
index.ts:3 unchanged), `RunEvent`, `Capabilities`, `FlowInfo`, `CreateRunParams`,
`CreateRunResult`, `StageOverrides`, `StageDecl`, `LoopDecl`, `FlowDoc`, `RepoFlowInfo`,
`RepoProviderInfo`, `CompleteRequest`, `CompleteResponse`, `CreatedTask`, `Finding`.

Values: `MAX_BODY_BYTES`, `MAX_TITLE_BYTES`, `TRANSPORTS`, `FLOW_NAME_RE` (the ONE repo-name
grammar — custom.ts's private `NAME_RE` is deleted in favor of it, as its own comment already
claims), `KEY_ENV_RE`, `CUSTOM_PROVIDER_KEYS`, `WIRE_PROVIDER_NAMES` (literal — PROVIDER_NAMES
is derived inside node-only registry.ts; a core test pins `toEqual(PROVIDER_NAMES)`, which also
pins order), `FINDING_SEVERITIES`, `FINDING_KINDS` (literal arrays; structured/findings.ts
derives its `z.enum(...)` from them).

Every current home re-exports from wire instead of declaring locally: `core/types.ts`
(ReasoningEffort), `events.ts` (RunEvent — its "import-free" header comment is rewritten to
point at wire as the home), `tasks/create.ts`, `api/capabilities.ts` (Capabilities, FlowInfo,
TRANSPORTS), `flows/types.ts`, `flows/repo.ts` (FLOW_NAME_RE), `agents/custom.ts` (grammar
constants), `sidecar/sidecar.ts` (param/result types), `api/complete.ts`,
`structured/findings.ts` (enums). Pure moves — no runtime path changes anywhere (every core
RunEvent import is already `import type`; nothing pattern-matches at a site a re-export alters).

### `scripts/gen-desktop-wire.ts` (NEW)

Reads `src/wire.ts`, prepends `// GENERATED from src/wire.ts — do not edit; run pnpm gen:wire`,
writes `apps/desktop/src/wire.ts` (header + exact source bytes, trailing newline included).
Root package.json gains `"gen:wire"`.

### Drift guard (NEW, root)

`src/wire.test.ts`: byte-compares desktop copy against header + core source; plus the
zero-imports assertion; plus the `WIRE_PROVIDER_NAMES === PROVIDER_NAMES` pin (in registry.test
or here). Runs in `pnpm test` → existing CI. No formatter exists on either side to rewrite the
generated file (verified: no prettier/biome configs, desktop has no lint script, root lint globs
root `src/` only) — the byte compare is safe as the repo stands.

### Desktop adoption

- `ipc.ts` deletes its hand-mirrors and re-exports from `./wire` (feature imports stay
  `../../ipc`). Its `CompleteParams` becomes `Omit<CompleteRequest, 'baseUrl'>` — the security
  subset is now *derived*, not mirrored, and keeps its no-baseUrl rationale comment.
- `typedRunReducer.ts`: imports wire's `RunEvent`, **re-exports it** (Inspector.tsx:32 imports
  RunEvent from the reducer — keep that path working), and exports
  `type AppRunEvent = RunEvent | { type: 'run-accepted' }` (today's private `Incoming`) — the
  Rust-minted variant stays a desktop extension with a comment saying why (core never emits it).
- `docTask.ts` (MAX_*, TRANSPORTS — keeps `isTransport`), `flowEditorReducer.ts` (re-exports
  wire's FLOW_NAME_RE), `customProviders.ts` (PROVIDERS→WIRE_PROVIDER_NAMES, FLOW_NAME_RE,
  KEY_ENV_RE, CUSTOM_PROVIDER_KEYS), `components/findings.ts` (Finding + enums) import from
  `./wire` and delete their copies. Messages stay UI copy.
- `vanguard-output.d.ts` untouched; its header gains one line pointing at wire.ts.

## 4. Scope

**Out (with triggers):** the TS↔Rust mirror set (trigger: S9 moves board types onto the wire);
a published types package (trigger: a third consumer); sharing predicate logic
(customProviderRowError / NewRunForm validation are UI-copy wrappers whose constants are now all
wire's — that is the part that drifts in practice).

## 5. Acceptance criteria

1. Pure-move guarantee: root suite green with zero test-body changes except new wire tests; CLI
   byte-identical (imports only — no runtime changes).
2. Drift guard mutation-verified in both directions (edit core wire without regen → root test
   fails naming `pnpm gen:wire`; edit desktop copy → same).
3. Zero-imports + syntax-ceiling assertions pass; desktop typecheck + vite build green locally
   (no CI surface for this yet — stated limitation).
4. Mirror deletion verified by review (decided: review-only — a grep test would false-positive
   on the generated copy itself and on legitimate local constants; the drift guard protects the
   shared truth, and a post-merge re-declaration is dead-code shadowing ordinary review catches).
5. `WIRE_PROVIDER_NAMES` pin green; add a provider without touching wire → root tests fail.
6. Desktop suite green; `run-accepted` reducer tests pass untouched; a type-level test pins that
   `AppRunEvent` accepts the variant.

## 6. Test plan

wire.test.ts (drift compare + both mutations + zero-imports incl. dynamic-import tokens);
registry pin; findings-enum pin (`z.enum` derived from wire arrays — zod schema unchanged
behavior, pinned by existing structured tests). Desktop: existing suites are the regression net;
one new `AppRunEvent` type test. Live: none — no runtime behavior changes.

## 7. Delivery

One PR. Not because a split half-deletes mirrors (core-first would leave them intact) — but
because a core-first PR would put a THIRD copy of every truth into the desktop (hand mirrors +
generated wire) with the hand mirrors unguarded: worse than the status quo. Adoption is
mechanical import swaps with the desktop suite as the net.

## 8. Review adjudication (round 1 — 2 lenses, 17 findings)

Adopted: ReasoningEffort moves to wire + core/types.ts re-export (blocking — zero-imports and
pure-move were contradictory without it); TRANSPORTS added (blocking/major in both lenses — AC 4
was unsatisfiable); CustomProviderSpec dropped from wire (Settings' Row is AppConfig-derived —
the draft's parenthetical was wrong and would have broken the serde round-trip);
CompleteRequest/Response + Finding/enums + CreatedTask added (inventory was incomplete — the
"kills the class" claim was false without them); TS 5.9 syntax ceiling; one-grammar unification
(FLOW_NAME_RE, deleting custom.ts's private twin); typedRunReducer re-export for Inspector;
single-file zero-imports check incl. dynamic imports (the lazy-imports walk masks `import(`);
events.ts header rewrite; §1 inventory corrections; AC 4 decided review-only; §2 alias rejection
rewritten (type-only is structurally insufficient — values; the single-file full alias is the
real alternative, rejected on self-containment + CI failure-locality); §7 justification
corrected (third-copy argument).

Rejected: none — every finding either adopted or was an anti-finding the reviewers themselves
flagged as not-to-raise (formatter risk, coverage ratchet, run-accepted-into-core, sharing the
zod schema itself).
