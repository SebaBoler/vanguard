# Changelog

## [1.2.0](https://github.com/SebaBoler/vanguard/compare/v1.1.1...v1.2.0) (2026-10-08)


### Features

* deps: migrate to execa 10 (SebaBoler/vanguard[#397](https://github.com/SebaBoler/vanguard/issues/397)) ([#432](https://github.com/SebaBoler/vanguard/issues/432)) ([3eb4fa9](https://github.com/SebaBoler/vanguard/commit/3eb4fa9b8fadcffc3856c99b413761abc1db498d))


### Bug Fixes

* cut the task worktree from origin/&lt;base&gt; when it is ahead of the local base ([#429](https://github.com/SebaBoler/vanguard/issues/429)) ([#431](https://github.com/SebaBoler/vanguard/issues/431)) ([50cf147](https://github.com/SebaBoler/vanguard/commit/50cf147736e394a687f40b77262ff53815e5fe02))

## [1.1.1](https://github.com/SebaBoler/vanguard/compare/v1.1.0...v1.1.1) (2026-10-08)


### Bug Fixes

* rebase the task branch onto the remote base before publishing ([#423](https://github.com/SebaBoler/vanguard/issues/423)) ([#426](https://github.com/SebaBoler/vanguard/issues/426)) ([16d70d1](https://github.com/SebaBoler/vanguard/commit/16d70d1918e8a46bf2e9003a16673208c1823217))

## [1.1.0](https://github.com/SebaBoler/vanguard/compare/v1.0.0...v1.1.0) (2026-10-08)


### Features

* --escalate-model — resume the 2nd+ gate repair on a stronger model ([#407](https://github.com/SebaBoler/vanguard/issues/407)) ([5f4dcd9](https://github.com/SebaBoler/vanguard/commit/5f4dcd93faa51c35b2698ed1895b87aa4f9580ff))
* current-generation models — 5.5/Fable 5.1 prices, aliases repointed, alias resolution not a swap ([#417](https://github.com/SebaBoler/vanguard/issues/417)) ([8c37e59](https://github.com/SebaBoler/vanguard/commit/8c37e5952592fc890240a256cd0c7393a51a6a9a))
* decision model as fork scorer and eval judge ([#413](https://github.com/SebaBoler/vanguard/issues/413)) ([f12f011](https://github.com/SebaBoler/vanguard/commit/f12f0117ee2fb3d7bda85adc832bb1200d962409))
* **desktop:** collapsible icon sidebar + shell alignment + single @/ui seam ([#312](https://github.com/SebaBoler/vanguard/issues/312)) ([4cb02fa](https://github.com/SebaBoler/vanguard/commit/4cb02fa4ff4d8c975d233ccd2400a34de2914500))
* **desktop:** Kanban board glow-up + project-color hover + rail collapse fix ([#315](https://github.com/SebaBoler/vanguard/issues/315)) ([7591793](https://github.com/SebaBoler/vanguard/commit/75917934348810229f3346c7f314eb08b17d9177))
* **desktop:** live cost/budget strip on the run viewer ([#317](https://github.com/SebaBoler/vanguard/issues/317)) ([b9bc59e](https://github.com/SebaBoler/vanguard/commit/b9bc59ebccd73c56effa57c7193baf3f613d8dba))
* **desktop:** show in-flight runs as rows in the Runs table, not a card ([#320](https://github.com/SebaBoler/vanguard/issues/320)) ([5ec052a](https://github.com/SebaBoler/vanguard/commit/5ec052a4302a5ad8e9e164f0ffb57ca2f9a1c250))
* Editor chrome: indent guides, bracket matching, status bar (Editor UX 2/7) (SebaBoler/vanguard[#357](https://github.com/SebaBoler/vanguard/issues/357)) ([#365](https://github.com/SebaBoler/vanguard/issues/365)) ([1c04130](https://github.com/SebaBoler/vanguard/commit/1c04130fab0e4ead3cd9b0669a70d6f6ab9873ea))
* Editor interaction: multi-cursor and VSCode keybindings (Editor UX 3/7) (SebaBoler/vanguard[#358](https://github.com/SebaBoler/vanguard/issues/358)) ([#367](https://github.com/SebaBoler/vanguard/issues/367)) ([619ea42](https://github.com/SebaBoler/vanguard/commit/619ea42863b00b2f7eebed7d7a3f3bdcccb7efc3))
* Editor UX upgrade (SebaBoler/vanguard[#352](https://github.com/SebaBoler/vanguard/issues/352)) ([#363](https://github.com/SebaBoler/vanguard/issues/363)) ([0dd0c8c](https://github.com/SebaBoler/vanguard/commit/0dd0c8cc139d6cc69b13b6b1c6657bf0325a6d4d))
* Linear tasks open GitLab MRs; review-mr skips reviewed heads ([#398](https://github.com/SebaBoler/vanguard/issues/398)) ([8cd4eea](https://github.com/SebaBoler/vanguard/commit/8cd4eea99404a1e2a7d98705e7dc971433b4e441))
* log-only difficulty probe via a decision model (Clef / System One API) ([#410](https://github.com/SebaBoler/vanguard/issues/410)) ([d95a353](https://github.com/SebaBoler/vanguard/commit/d95a35352a4be9f41c8a4799fde757f5e789e567))
* **review:** let review-mr and review-pr take --max-turns ([#402](https://github.com/SebaBoler/vanguard/issues/402)) ([39e503c](https://github.com/SebaBoler/vanguard/commit/39e503cbf0a1d66b89e4bbe186fbba7a28266386))
* **s10:** task drafts — the Docs page dies, authoring becomes task-first ([#349](https://github.com/SebaBoler/vanguard/issues/349)) ([f682b78](https://github.com/SebaBoler/vanguard/commit/f682b7828f1aa50dbf3bab08fef7745be230b5fd))
* **s4.3:** create a task from a doc — the app's first irreversible write ([#335](https://github.com/SebaBoler/vanguard/issues/335)) ([9c8050a](https://github.com/SebaBoler/vanguard/commit/9c8050a7d54c8ca16a214cf953d781b19f0ad945))
* **s5.1:** flows go live — .vanguard/flows/*.hcl discoverable, runnable, writable ([#336](https://github.com/SebaBoler/vanguard/issues/336)) ([d4272a2](https://github.com/SebaBoler/vanguard/commit/d4272a23b3bc3f7a79453aa95ccab84696970ef9))
* **s5.2:** visual flow editor — Workflow screen reads and writes real flow HCL ([#338](https://github.com/SebaBoler/vanguard/issues/338)) ([6ab753e](https://github.com/SebaBoler/vanguard/commit/6ab753e3686b641aa8b8f76d8fe82c00cb639b92))
* **s6.1:** custom providers go live — repo-configured Anthropic-compatible endpoints ([#340](https://github.com/SebaBoler/vanguard/issues/340)) ([89320fe](https://github.com/SebaBoler/vanguard/commit/89320fe0821a45852d840c39dc32935def39eaed))
* **s6.2:** custom providers in the app — NewRunForm merge, Settings editor, config data-safety ([#341](https://github.com/SebaBoler/vanguard/issues/341)) ([b93b195](https://github.com/SebaBoler/vanguard/commit/b93b19513272611ed973efb048ba43db87f5eb8f))
* **s7:** shared-types seam — one generated wire contract, mirror class deleted ([#342](https://github.com/SebaBoler/vanguard/issues/342)) ([828fe3c](https://github.com/SebaBoler/vanguard/commit/828fe3c168c5a41ab3d199c91d141e9d6503f374))
* **s8.1:** hygiene bundle — double-scroll, drag cancel, input feedback, strip bleed, nav guard ([#339](https://github.com/SebaBoler/vanguard/issues/339)) ([#343](https://github.com/SebaBoler/vanguard/issues/343)) ([62c4fbe](https://github.com/SebaBoler/vanguard/commit/62c4fbe2e1f941769821b3e732800892094e7f62))
* **s8.2:** in-app flow rename + delete (additive deleteFlow method) ([#345](https://github.com/SebaBoler/vanguard/issues/345)) ([fac70ff](https://github.com/SebaBoler/vanguard/commit/fac70ff001b3228f6df885ec9e6febcba0a39067))
* **s9.1:** board read path in core — listTasks/fetchSpec sidecar methods ([#346](https://github.com/SebaBoler/vanguard/issues/346)) ([45ea16a](https://github.com/SebaBoler/vanguard/commit/45ea16a1f631ab2c9969ecb19e13aad0c49b25fe))
* **s9.2:** the Rust board dies — one brain ([#348](https://github.com/SebaBoler/vanguard/issues/348)) ([5ca0227](https://github.com/SebaBoler/vanguard/commit/5ca02278a459ceb56ff919d945ca386f9948e670))
* **sidecar:** give short calls their own pipe; keep cancel pointed at the run child ([#334](https://github.com/SebaBoler/vanguard/issues/334)) ([69162fb](https://github.com/SebaBoler/vanguard/commit/69162fbfeaf095dbc7084230e5b408f0b18da293))
* **spec:** --base flag + auto-fetch origin baseline for the spec pass ([#311](https://github.com/SebaBoler/vanguard/issues/311)) ([5936a56](https://github.com/SebaBoler/vanguard/commit/5936a56f58f1f374c9438ba2a51bb92c361f8828))
* **task-page:** full-page editor with a tabbed chat drawer ([#350](https://github.com/SebaBoler/vanguard/issues/350)) ([24d0122](https://github.com/SebaBoler/vanguard/commit/24d012263c577e28453bdad99890c5b04884a8b9))
* vanguard metrics push + stats --branch — durable run metrics on an orphan branch ([#419](https://github.com/SebaBoler/vanguard/issues/419)) ([e8c76ef](https://github.com/SebaBoler/vanguard/commit/e8c76efe7c742a79638b7a8af592361db37b4b9a))
* vanguard:model=&lt;m&gt; issue label pins the implementer model per task ([#409](https://github.com/SebaBoler/vanguard/issues/409)) ([16f7481](https://github.com/SebaBoler/vanguard/commit/16f7481ef5d35895addb98a55c07dd2554589d21))
* **watch:** add --spec-only to run the loop-v1 spec pass alone ([#400](https://github.com/SebaBoler/vanguard/issues/400)) ([0155ebc](https://github.com/SebaBoler/vanguard/commit/0155ebc14a76c124d52042d80e6e3c3cd9003eae))


### Bug Fixes

* codex/cursor-only review needs no Anthropic credential; log why a watched item failed ([#422](https://github.com/SebaBoler/vanguard/issues/422)) ([abe3256](https://github.com/SebaBoler/vanguard/commit/abe3256e46512ccadf8061d45ae1b92031cf48d9))
* **desktop:** default runs to claude, drop dead zai/--llm-proxy hardcode ([#321](https://github.com/SebaBoler/vanguard/issues/321)) ([57d0669](https://github.com/SebaBoler/vanguard/commit/57d06694a7ecc7bc76f5c415c31bf9cd6220339e))
* **desktop:** Fleet watch-loop toggle falsely reads 'stopped' after navigating away (SebaBoler/vanguard[#318](https://github.com/SebaBoler/vanguard/issues/318)) ([#319](https://github.com/SebaBoler/vanguard/issues/319)) ([4d14e2b](https://github.com/SebaBoler/vanguard/commit/4d14e2bc9804547853b06a58e0f7a76fe576c731))
* **dogfood:** proxy EPIPE crash-loop killed run [#352](https://github.com/SebaBoler/vanguard/issues/352) again; live-run strip trapped the Runs page ([#354](https://github.com/SebaBoler/vanguard/issues/354)) ([e016ec0](https://github.com/SebaBoler/vanguard/commit/e016ec07b26bf6aa53d7489f6c9dd35ad8d98a38))
* fail fast when every assistant turn is a synthetic API error ([#392](https://github.com/SebaBoler/vanguard/issues/392)) ([eed565a](https://github.com/SebaBoler/vanguard/commit/eed565a82a478068a490933f21b837c3857a6b4b))
* follow-ups from the last [#398](https://github.com/SebaBoler/vanguard/issues/398) review ([#399](https://github.com/SebaBoler/vanguard/issues/399)) ([2315cfa](https://github.com/SebaBoler/vanguard/commit/2315cfa4b8879b9d6dea41e6784e449c602bee7d))
* gate runs on the pinned sandbox claude CLI, add doctor --fix ([#393](https://github.com/SebaBoler/vanguard/issues/393)) ([70729db](https://github.com/SebaBoler/vanguard/commit/70729db40875d1bcc21c2e5bdc61b858147c6cb1))
* keep truncations visible after repair, annotate gateway swaps in stats, map Claude aliases on openrouter ([#406](https://github.com/SebaBoler/vanguard/issues/406)) ([6d37155](https://github.com/SebaBoler/vanguard/commit/6d37155ac7b1aef9eace5279efa4829b45db3bcc))
* **linear:** list over GraphQL — `vanguard watch --linear` was broken on every poll ([#333](https://github.com/SebaBoler/vanguard/issues/333)) ([4203660](https://github.com/SebaBoler/vanguard/commit/4203660d382f60a15c44624ab225dd705db50544))
* log a self-contradicting review verdict (clean verdict, high finding) ([#412](https://github.com/SebaBoler/vanguard/issues/412)) ([48a485c](https://github.com/SebaBoler/vanguard/commit/48a485c0b44d593fa7a9c4ff6b8627ed8e71c337))
* loop-v1 spec pass researches against --base ([#401](https://github.com/SebaBoler/vanguard/issues/401)) ([e50d60b](https://github.com/SebaBoler/vanguard/commit/e50d60b237d37902a457b2704979fac3b33a862e))
* **pipeline:** an incomplete implementer fails the quality gate — no more residue PRs ([#356](https://github.com/SebaBoler/vanguard/issues/356)) ([d83c3d7](https://github.com/SebaBoler/vanguard/commit/d83c3d7a80b52aea3623e97d0c91f4805a0930aa))
* **pr-review:** failed reviews retry instead of posing as success; pin event PR past stale label scan ([#344](https://github.com/SebaBoler/vanguard/issues/344)) ([727a00a](https://github.com/SebaBoler/vanguard/commit/727a00a074f2dd660c344a1c9ce8a78d71b86b9a))
* review verdict first — accept a stated verdict without the completion signal, stop calling small diffs too large ([#411](https://github.com/SebaBoler/vanguard/issues/411)) ([a23f663](https://github.com/SebaBoler/vanguard/commit/a23f66345479e377c4d371496579616892d6af1a))
* route repair loops on the implementer model, keep all-attempt cost, stats by model ([#404](https://github.com/SebaBoler/vanguard/issues/404)) ([45975c1](https://github.com/SebaBoler/vanguard/commit/45975c11bf167d5ead1c779581f76367fe5b66cf))
* **sandbox:** coerce undefined execa streams in ExecResult ([#382](https://github.com/SebaBoler/vanguard/issues/382)) ([194bb6f](https://github.com/SebaBoler/vanguard/commit/194bb6fb808404a48e9da4259a1f1a41276547ca))
* **sandbox:** supervise the egress proxy — proxy death bricked run [#352](https://github.com/SebaBoler/vanguard/issues/352) ([#353](https://github.com/SebaBoler/vanguard/issues/353)) ([6ba7c86](https://github.com/SebaBoler/vanguard/commit/6ba7c860e7c4a83746a4709041d71de4e089d797))
* **spec:** resume incomplete tech-spec, keep text on empty result ([#380](https://github.com/SebaBoler/vanguard/issues/380)) ([39bd9d5](https://github.com/SebaBoler/vanguard/commit/39bd9d517eb06b8b743a638b30428dfdcd2982f6))
* **spec:** tech-spec turn cap 15→30, wire --max-turns, planner 10→15 ([#347](https://github.com/SebaBoler/vanguard/issues/347)) ([a61940d](https://github.com/SebaBoler/vanguard/commit/a61940d3426e106b745dc1a77c95f999459e2d21))
* **task-page:** dogfood r3 — unbreak doc chat, split conversation/doc naming into InlineEdits ([#351](https://github.com/SebaBoler/vanguard/issues/351)) ([e68db34](https://github.com/SebaBoler/vanguard/commit/e68db34f83aa0056150479aa1ab8d06c021612a2))
* **watch:** carry the stack into failure comments ([#381](https://github.com/SebaBoler/vanguard/issues/381)) ([5ea9006](https://github.com/SebaBoler/vanguard/commit/5ea900634a756e0f353106b0456217d22d853851))
