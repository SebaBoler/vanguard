# Structured `<findings>` Rendering — Desktop Inspector

> **Status:** Draft, ready to implement. Scope: `apps/desktop/` only, no Vanguard-core change.
> **Related:** [SebaBoler/vanguard#292](https://github.com/SebaBoler/vanguard/issues/292) — upstream bug,
> adversary-stage `<findings>` prompt is underspecified, model emits either a bare JSON array or a
> `{"findings":[...]}` object roughly at random. This spec is the desktop-side fix; it does **not** depend
> on #292 landing (see §2 — normalization is needed permanently regardless of the upstream fix).

---

## 1. Problem

`StageCard` renders each stage's `finalText` through `AgentText` (`apps/desktop/src/components/AgentText.tsx`),
which recognizes `<tag>…</tag>` blocks and renders them as a `Chip` (short, single-line) or a `Callout`
(multi-line) wrapping raw `Markdown`. The adversary stage's `<findings>` block is a JSON payload
(`{severity, kind, title, evidence}` items), not markdown — today it renders as one undifferentiated wall
of JSON text inside a callout, instead of the per-finding, severity-colored blocks the data supports.

## 2. Data contract (from real `.vanguard/runs/*-adversary.json` on disk)

Item shape, consistent across all real records:

```ts
type Finding = {
  severity: 'low' | 'medium' | 'high' | 'critical'
  kind: 'security' | 'perf' | 'correctness' | 'style'
  title: string
  evidence: string
}
```

Top-level shape is **not** consistent — two forms occur in real data, interleaved throughout run history
with no time-based cutover (confirmed: not a version/schema drift, see #292):

```
<findings>{"findings":[ {...}, {...} ]}</findings>   // wrapped object
<findings>[ {...}, {...} ]</findings>                 // bare array
<findings>[]</findings>                                // empty (zero findings — valid, not an error)
```

**Why normalize even if #292 is fixed upstream:** a prompt/schema fix only affects *future* runs. Every
`.vanguard/runs/**/*.json` already on disk today keeps whichever shape it was written with — the inspector
reads historical runs, so both shapes remain permanently possible input. This is not a stopgap; it's the
correct steady-state parser.

## 3. Design

Dispatch on **tag name**, not stage name — `stage` is free-form `string` end-to-end (Rust struct, TS
pipeline, persisted JSON; no stricter type exists anywhere to key off), but tag names are a small, stable,
hand-authored set (`plan`, `findings`, `promise`, `violations`, `tech_spec`, `spec_manifest`). `AgentText`
already parses tag name + inner text; add one more case.

`apps/desktop/src/components/findings.ts` (new, pure parsing — no React):

```ts
export type Finding = {
  severity: 'low' | 'medium' | 'high' | 'critical'
  kind: 'security' | 'perf' | 'correctness' | 'style'
  title: string
  evidence: string
}

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const KINDS = new Set(['security', 'perf', 'correctness', 'style'])

function isFinding(x: unknown): x is Finding {
  if (typeof x !== 'object' || x === null) return false
  const f = x as Record<string, unknown>
  return (
    typeof f.severity === 'string' && SEVERITIES.has(f.severity) &&
    typeof f.kind === 'string' && KINDS.has(f.kind) &&
    typeof f.title === 'string' &&
    typeof f.evidence === 'string'
  )
}

/** Parses a `<findings>` tag body. Accepts both `{"findings":[...]}` and a bare `[...]`. Returns null on any shape mismatch — caller falls back to raw rendering. */
export function parseFindings(inner: string): Finding[] | null {
  let json: unknown
  try {
    json = JSON.parse(inner)
  } catch {
    return null
  }
  const arr = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null && Array.isArray((json as { findings?: unknown }).findings)
      ? (json as { findings: unknown[] }).findings
      : null
  if (arr === null || !arr.every(isFinding)) return null
  return arr
}
```

No zod: root `package.json` has zod (used by Vanguard core's own `findingsSchema`), but it's not a
dependency of `apps/desktop`'s own `package.json` — adding it for one four-field type guard is not worth
the new dependency. Plain type guard is ~15 lines and fully covers the shape.

`AgentText.tsx` — a local, non-exported `FindingsList` component plus one new branch ahead of the existing
chip/callout split, only for `tag === 'findings'`. `FindingsList` has exactly one call site and no reuse
anywhere else in this design, so it lives next to the dispatch code that owns it rather than its own module:

```tsx
function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <div className="text-sm text-muted-foreground">No findings.</div>
  return (
    <div className="space-y-3">
      {findings.map((f, i) => (
        <div key={i}>
          <div className="flex items-center gap-2">
            <Chip color={severityColor(f.severity)}>{f.severity}</Chip>
            <span className="text-xs text-muted-foreground">{f.kind}</span>
            <span className="font-medium">{f.title}</span>
          </div>
          <Markdown>{f.evidence}</Markdown>
        </div>
      ))}
    </div>
  )
}
```

Dispatch (inside the existing tag-matching loop):

```tsx
if (tag === 'findings') {
  const findings = parseFindings(inner)
  if (findings) {
    parts.push(<FindingsList key={key++} findings={findings} />)
    last = m.index + m[0].length
    continue
  }
  // fall through to existing Callout+Markdown rendering on parse/shape failure
}
```

`severityColor`: `low` → `secondary`/muted, `medium` → `warning`, `high`/`critical` → `destructive` —
matching the existing `Chip` color vocabulary already used in `StageCard`. Collapsing `high`/`critical` to
one color is intentional: `Chip` doesn't have a bucket beyond `destructive` for "worse than high", and the
severity text itself (rendered inside the chip) already carries that distinction.

Zero findings (`<findings>[]</findings>`) is real, currently-occurring data (§2), not hypothetical — the
dedicated "No findings." line disambiguates "checked, clean" from a broken/empty render.

## 4. Testing

`apps/desktop/src/components/findings.test.ts` (new) — unit tests for `parseFindings`, table-driven over
real shapes: wrapped-object, bare-array, empty array, malformed JSON (`{`), well-formed JSON with a missing/
invalid field (e.g. `severity: "extreme"`), non-array top-level (`{"foo":1}`). Each asserts either the
exact parsed `Finding[]` or `null`.

`apps/desktop/src/components/AgentText.test.tsx` (new — none exists today) — render tests for `AgentText`
covering the new `findings` branch (severity chip + title/evidence text per finding, zero-findings empty
state, fallback to raw Callout+Markdown on malformed `<findings>` content) alongside the component's
existing chip/callout/markdown behavior, so the file tests what it owns rather than a phantom subcomponent.

## 5. Non-goals

- Not fixing the upstream prompt/schema — tracked in vanguard#292, separate repo, separate PR.
- Not migrating/rewriting historical `.vanguard/runs/*.json` files to a canonical shape — read-time
  normalization only.
- Not generalizing to other JSON-bearing tags (none exist today — `<plan>` is always markdown, `<promise>`
  is always the literal `COMPLETE`, `<violations>`/`<tech_spec>` are unparsed prose/markdown per current
  usage). Add a case if/when a second structured tag actually appears.
