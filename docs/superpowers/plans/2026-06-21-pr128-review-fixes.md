# PR #128 review fixes (feat/zai-provider)

> Fixes the 4 P1 functional blockers from review 4540013082. Each task is independent except
> Tasks 3 & 4 both touch `registry.ts` — run them sequentially. TDD: failing test first.

**Branch:** `feat/zai-provider`. **Gate per task:** `npx tsc --noEmit` + `npm test` green.

## Global constraints
- ESM NodeNext (`.js`/`.mjs` import suffixes). TS strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess.
- Sidecar (`*.mjs`) is zero-dep (node builtins only). Never log headers/body/secret/nonce.
- No new runtime deps. Vitest runner.

---

## Task 1 — z.ai proxy forwards the Coding-Plan base path (P1)

**Bug:** sidecar forwards `req.url` (`/v1/messages`) verbatim to `api.z.ai`, producing
`https://api.z.ai/v1/messages`. z.ai Coding Plan requires `https://api.z.ai/api/coding/paas/v4/v1/messages`
(matches `ZAI_BASE_URL` in `src/agents/zai.ts`). Anthropic/OpenAI upstreams have no base path.

**Files:** `src/sandbox/llm-proxy-rewrite.mjs`, `src/sandbox/llm-proxy-rewrite.d.mts`,
`src/sandbox/llm-proxy-server.mjs`, test `src/sandbox/llm-proxy-rewrite.test.ts`.

1. `UPSTREAMS.zai` gains `basePath: '/api/coding/paas/v4'` (comment: keep in sync with `ZAI_BASE_URL`).
   anthropic/openai entries omit it (treated as `''`).
2. New pure export in `.mjs`:
   ```js
   /** Outbound upstream path: the upstream's base path prefix + the inbound request path (query kept). */
   export function upstreamPath(upstream, reqUrl) {
     const spec = UPSTREAMS[upstream];
     return `${spec?.basePath ?? ''}${reqUrl ?? '/'}`;
   }
   ```
3. `.d.mts`: add `basePath?: string` to `UpstreamSpec`; declare
   `export declare function upstreamPath(upstream: Upstream, reqUrl: string | undefined): string;`
4. `server.mjs`: import `upstreamPath`; replace `const path = req.url ?? '/';` with
   `const path = upstreamPath(upstreamKind, req.url);`
5. Test: `upstreamPath('zai','/v1/messages') === '/api/coding/paas/v4/v1/messages'`;
   `upstreamPath('anthropic','/v1/messages') === '/v1/messages'`; query preserved
   (`'/v1/messages?beta=1'` → suffix kept); `upstreamPath('zai', undefined) === '/api/coding/paas/v4/'`.

---

## Task 2 — spec pass must not force `haiku` onto z.ai (P1)

**Bug:** `techSpecStage()` defaults `model: 'haiku'`; `ZaiProvider` treats any model as explicit and
never applies `glm-5.2`, so a `--provider zai` spec run sends `haiku` (which z.ai does not serve).

**Files:** `src/pipeline/pipeline.ts` (`techSpecStage`), `src/runners/spec.ts`, test `src/runners/spec.test.ts`.

1. `techSpecStage`: stop forcing the default — omit `model` when not supplied:
   `...(opts?.model !== undefined ? { model: opts.model } : {})` (drop `model: opts?.model ?? 'haiku'`).
   Update the doc comment: model is omitted unless supplied; the caller owns the provider-aware default.
2. `spec.ts` (`runSpecGenerator`, line ~137): compute the default provider-aware, then pass:
   ```ts
   // haiku keeps the spec pass cheap on Claude; z.ai doesn't serve haiku, so let ZaiProvider pick its
   // own default (glm). An explicit --spec-model always wins.
   const specModel = deps.specModel ?? (deps.provider === 'zai' ? undefined : 'haiku');
   const stages = techSpecStage(specModel !== undefined ? { model: specModel } : {});
   ```
   (`deps.provider` already exists via `ProviderChoice`.)
3. Regression test (`spec.test.ts`): inject a recording agent that captures `input.model`; run
   `runSpecGenerator` with `provider: 'zai'`, no `specModel` → captured model is `undefined`
   (ZaiProvider would then apply glm). With `provider` omitted/claude, no specModel → captured `'haiku'`.
   With explicit `specModel: 'sonnet'` + provider zai → `'sonnet'`.

---

## Task 3 — auth required only when actually used (P1)

**Bug:** `agentAuthFromEnv(provider)` resolves from the PRIMARY provider only and demands an Anthropic
credential for every non-zai primary. The supported direct combo `codex|cursor` implement + `zai` review
needs no Anthropic credential (`selectAgents` sets `injectAnthropicAuth=false`) yet fails before dispatch.

**Files:** `src/agents/auth.ts`, `src/agents/registry.ts`, `src/cli/run.ts`, `src/cli/watch.ts`,
`src/cli/review-pr.ts`, `src/runners/github.ts`, `src/runners/linear.ts`, `src/runners/spec.ts`,
`src/sandbox/sandbox-context.ts`, tests `src/agents/auth.test.ts` (+ adjust callers' tests as needed).

1. `registry.ts`: export
   ```ts
   /** True when the run needs an Anthropic-family credential (subscription token / API key). A provider
    *  that owns the Anthropic transport with its own creds (zai) in the used set suppresses the need. */
   export function needsAnthropicAuth(choice: ProviderChoice): boolean {
     const provider = choice.provider ?? 'claude';
     const used: ProviderName[] = [provider, ...(choice.reviewProvider !== undefined ? [choice.reviewProvider] : [])];
     return !used.some((n) => spec(n).ownsAnthropicTransport === true);
   }
   ```
2. `auth.ts`: change signature to take the full choice and return optional:
   ```ts
   export function agentAuthFromEnv(
     choice: { provider?: ProviderName; reviewProvider?: ProviderName },
     env: NodeJS.ProcessEnv = process.env,
   ): AgentAuth | undefined {
     if (choice.provider === 'zai') {
       const key = env['ZAI_API_KEY'];
       if (key === undefined || key === '') throw new Error('Set ZAI_API_KEY before running with --provider zai.');
       return { mode: 'api', apiKey: key };
     }
     if (!needsAnthropicAuth(choice)) return authFromEnv(env); // suppressed (e.g. codex/cursor + zai review): unused, may be undefined
     const auth = authFromEnv(env);
     if (auth === undefined) {
       throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
     }
     return auth;
   }
   ```
   (Import `needsAnthropicAuth` from `registry.js`. Watch for an import cycle — `registry` must not import `auth`; it does not today.)
3. Make `auth` optional where it is now required, threading the optional through:
   - `sandbox-context.ts` `SandboxContextOptions.auth?: AgentAuth`; in the `llmProxy` branch, guard:
     `if (opts.auth === undefined) throw new Error('llm-proxy needs a primary-sidecar credential');` before `llmProxyAuth(opts.auth)`.
   - `runners/github.ts` `RunGithubIssueDeps.auth?`, `runners/linear.ts` `RunLinearIssueDeps.auth?`,
     `runners/spec.ts` `RunSpecGeneratorDeps.auth?`.
   - `github.ts` injection site: `...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth ? authSecrets(deps.auth) : {})`. Same pattern wherever `authSecrets(deps.auth)` / `authSecrets(auth)` is called — guard on defined.
   - `spec.ts` `defaultSandboxFactory`: guard `deps.auth !== undefined` alongside `injectAnthropicAuth`.
4. Update callers to pass the choice object:
   - `run.ts`: `requireAuth` takes the cmd → `agentAuthFromEnv({ provider: cmd.provider, reviewProvider: cmd.reviewProvider })`.
     `runCommand`'s `auth` is now `AgentAuth | undefined`; thread the optional into `startSandboxContext`/deps.
   - `watch.ts:24`, `review-pr.ts:39`, `github.ts:167` (`githubDepsFromEnv`), `linear.ts:168`: pass
     `{ provider, reviewProvider }` (use the values available at each site; `githubDepsFromEnv` gains a `reviewProvider?` param OR reads from the cmd — keep it minimal: add `reviewProvider?: ProviderName` param).
5. Tests (`auth.test.ts`): `agentAuthFromEnv({provider:'codex', reviewProvider:'zai'}, {ZAI_API_KEY:'z', CODEX_API_KEY:'c'})` (no Anthropic) → does NOT throw (returns undefined). `{provider:'codex'}` with no Anthropic → throws. `{provider:'zai'}` no ZAI key → throws. `{provider:'claude'}` with token → subscription auth.

---

## Task 4 — preflight validates the provider combo before claiming (P1)

**Bug:** watch preflight checks keys via `providerSecrets` but skips `selectAgents`' combo checks
(transport collision; reviewer-only zai under `--llm-proxy`). An invalid combo passes preflight,
claims an issue, then the runner throws → issue stuck claimed.

**Files:** `src/agents/registry.ts`, `src/cli/preflight.ts`, tests `src/cli/preflight.test.ts`.

1. `registry.ts`: extract the two `AgentError` checks from `selectAgents` into
   ```ts
   /** Throws when the provider/reviewProvider combination cannot run in one sandbox. */
   export function validateProviderChoice(choice: ProviderChoice, opts: ProviderSecretOptions = {}): void { ... }
   ```
   `selectAgents` calls it (behaviour unchanged — same throws, same messages).
2. `preflight.ts`: after the provider-auth check, call it and report:
   ```ts
   try {
     validateProviderChoice({ provider: cmd.provider, reviewProvider: cmd.reviewProvider }, { proxyMode: cmd.llmProxy === true });
     checks.push(check('provider combo', true));
   } catch (error) {
     checks.push(check('provider combo', false, error instanceof Error ? error.message : String(error)));
   }
   ```
   (`reviewProvider` exists on watch commands; `doctor-prs` has none → undefined, single-provider always valid.)
3. Tests (`preflight.test.ts`): a `claude` + `zai`-review watch cmd → report has `provider combo` failing;
   a valid `codex` + `zai`-review → `provider combo` ok.
