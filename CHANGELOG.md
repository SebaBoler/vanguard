# Changelog

## [1.1.0](https://github.com/SebaBoler/vanguard/compare/v1.0.0...v1.1.0) (2026-07-20)


### Features

* **desktop:** collapsible icon sidebar + shell alignment + single @/ui seam ([#312](https://github.com/SebaBoler/vanguard/issues/312)) ([4cb02fa](https://github.com/SebaBoler/vanguard/commit/4cb02fa4ff4d8c975d233ccd2400a34de2914500))
* **desktop:** Kanban board glow-up + project-color hover + rail collapse fix ([#315](https://github.com/SebaBoler/vanguard/issues/315)) ([7591793](https://github.com/SebaBoler/vanguard/commit/75917934348810229f3346c7f314eb08b17d9177))
* **desktop:** live cost/budget strip on the run viewer ([#317](https://github.com/SebaBoler/vanguard/issues/317)) ([b9bc59e](https://github.com/SebaBoler/vanguard/commit/b9bc59ebccd73c56effa57c7193baf3f613d8dba))
* **desktop:** show in-flight runs as rows in the Runs table, not a card ([#320](https://github.com/SebaBoler/vanguard/issues/320)) ([5ec052a](https://github.com/SebaBoler/vanguard/commit/5ec052a4302a5ad8e9e164f0ffb57ca2f9a1c250))
* Editor chrome: indent guides, bracket matching, status bar (Editor UX 2/7) (SebaBoler/vanguard[#357](https://github.com/SebaBoler/vanguard/issues/357)) ([#365](https://github.com/SebaBoler/vanguard/issues/365)) ([1c04130](https://github.com/SebaBoler/vanguard/commit/1c04130fab0e4ead3cd9b0669a70d6f6ab9873ea))
* Editor interaction: multi-cursor and VSCode keybindings (Editor UX 3/7) (SebaBoler/vanguard[#358](https://github.com/SebaBoler/vanguard/issues/358)) ([#367](https://github.com/SebaBoler/vanguard/issues/367)) ([619ea42](https://github.com/SebaBoler/vanguard/commit/619ea42863b00b2f7eebed7d7a3f3bdcccb7efc3))
* Editor UX upgrade (SebaBoler/vanguard[#352](https://github.com/SebaBoler/vanguard/issues/352)) ([#363](https://github.com/SebaBoler/vanguard/issues/363)) ([0dd0c8c](https://github.com/SebaBoler/vanguard/commit/0dd0c8cc139d6cc69b13b6b1c6657bf0325a6d4d))
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


### Bug Fixes

* **desktop:** default runs to claude, drop dead zai/--llm-proxy hardcode ([#321](https://github.com/SebaBoler/vanguard/issues/321)) ([57d0669](https://github.com/SebaBoler/vanguard/commit/57d06694a7ecc7bc76f5c415c31bf9cd6220339e))
* **desktop:** Fleet watch-loop toggle falsely reads 'stopped' after navigating away (SebaBoler/vanguard[#318](https://github.com/SebaBoler/vanguard/issues/318)) ([#319](https://github.com/SebaBoler/vanguard/issues/319)) ([4d14e2b](https://github.com/SebaBoler/vanguard/commit/4d14e2bc9804547853b06a58e0f7a76fe576c731))
* **dogfood:** proxy EPIPE crash-loop killed run [#352](https://github.com/SebaBoler/vanguard/issues/352) again; live-run strip trapped the Runs page ([#354](https://github.com/SebaBoler/vanguard/issues/354)) ([e016ec0](https://github.com/SebaBoler/vanguard/commit/e016ec07b26bf6aa53d7489f6c9dd35ad8d98a38))
* **linear:** list over GraphQL — `vanguard watch --linear` was broken on every poll ([#333](https://github.com/SebaBoler/vanguard/issues/333)) ([4203660](https://github.com/SebaBoler/vanguard/commit/4203660d382f60a15c44624ab225dd705db50544))
* **pipeline:** an incomplete implementer fails the quality gate — no more residue PRs ([#356](https://github.com/SebaBoler/vanguard/issues/356)) ([d83c3d7](https://github.com/SebaBoler/vanguard/commit/d83c3d7a80b52aea3623e97d0c91f4805a0930aa))
* **pr-review:** failed reviews retry instead of posing as success; pin event PR past stale label scan ([#344](https://github.com/SebaBoler/vanguard/issues/344)) ([727a00a](https://github.com/SebaBoler/vanguard/commit/727a00a074f2dd660c344a1c9ce8a78d71b86b9a))
* **sandbox:** supervise the egress proxy — proxy death bricked run [#352](https://github.com/SebaBoler/vanguard/issues/352) ([#353](https://github.com/SebaBoler/vanguard/issues/353)) ([6ba7c86](https://github.com/SebaBoler/vanguard/commit/6ba7c860e7c4a83746a4709041d71de4e089d797))
* **spec:** tech-spec turn cap 15→30, wire --max-turns, planner 10→15 ([#347](https://github.com/SebaBoler/vanguard/issues/347)) ([a61940d](https://github.com/SebaBoler/vanguard/commit/a61940d3426e106b745dc1a77c95f999459e2d21))
* **task-page:** dogfood r3 — unbreak doc chat, split conversation/doc naming into InlineEdits ([#351](https://github.com/SebaBoler/vanguard/issues/351)) ([e68db34](https://github.com/SebaBoler/vanguard/commit/e68db34f83aa0056150479aa1ab8d06c021612a2))
