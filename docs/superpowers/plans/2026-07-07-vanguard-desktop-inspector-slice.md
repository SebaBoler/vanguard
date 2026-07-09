# Vanguard Inspector — Inspector Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Tauri 2 → Rust → React → chunks-ui seam end-to-end by building the thinnest useful Vanguard cockpit: point at a repo, list its `.vanguard/` runs, open one, and render its stage cards, proof-of-work gate, diff, and transcript — all from static file reads.

**Architecture:** A Tauri 2 app at `apps/desktop/` inside the Vanguard repo. The Rust backend reads a repo's `.vanguard/runs/` off disk via two `#[tauri::command]`s that are thin wrappers over pure, unit-tested functions in `runs.rs`. React 19 + Vite + chunks-ui renders a run list → run detail. Typed JSON over IPC (a hand-mirrored `vanguard-output.d.ts`) is the only boundary. No process control, no filesystem watching, no git-bundle plumbing — everything is a static read (the diff is persisted as a plain `.diff` sibling file).

**Tech Stack:** Tauri 2 (`tauri`/`tauri-build` `2`), Rust (`serde` 1 + derive, `serde_json` 1), React 19, Vite, Tailwind v4 (`@tailwindcss/vite`), chunks-ui, TypeScript (strict), Vitest + Testing Library, pnpm, Node 24+.

## Global Constraints

- **Location:** all new code lives under `apps/desktop/` inside the Vanguard repo. Touch nothing else in the repo.
- **Never modify `.github/workflows/`** (repo CLAUDE.md hard constraint).
- **IPC is the only boundary:** React touches no process and no filesystem directly; it calls Rust commands and renders returned JSON. Rust owns all disk access.
- **v2 API exactly:** JS `invoke` imports from `@tauri-apps/api/core` (never `/tauri`). Command entry point lives in `lib.rs` `run()` with `#[cfg_attr(mobile, tauri::mobile_entry_point)]`; `main.rs` only calls `desktop_lib::run()`. `Cargo.toml` needs `[lib]` with `crate-type = ["staticlib","cdylib","rlib"]` and name `desktop_lib`. One `invoke_handler` / `generate_handler!` call only.
- **Arg naming:** JS sends camelCase keys; Rust command params are snake_case; Tauri maps them automatically (`repoPath` → `repo_path`).
- **Persisted JSON is camelCase** (`taskId`, `exitReason`, `worktreePath`, `outputTail`, …). Every Rust struct that (de)serializes a persisted shape uses `#[serde(rename_all = "camelCase")]`.
- **Static reads only in this slice:** no `spawn`, no `notify`, no live `sessions/*.jsonl` tailing, no `git` calls. Diff comes from the sibling `.diff` file, not the `.bundle`.
- **chunks-ui is a hard requirement** — the UI must render through it. It is Paweł's package: install the published `chunks-ui`, or `pnpm link` the local `chunks-ui/packages/ui` if it is not yet published. Its compound `Card` API is `Card.Root` / `Card.Header` / `Card.Title` / `Card.Description` / `Card.Content` / `Card.Footer`, each spreading props onto a `div`/heading with a merged `className`. Theme via `import 'chunks-ui/theme.css'`.
- **Run before declaring done:** `cd apps/desktop/src-tauri && cargo test`, and `cd apps/desktop && pnpm build && pnpm vitest run`.

### On-disk data contract (source of truth — do not re-derive)

Persisted by `src/core/run-record.ts` / `src/pipeline/verify.ts` in the target repo:

- Run record: `.vanguard/runs/<taskId>/<sanitizedTs>[-<stage>].json` — `RunResult` minus `diff`/`transcript`, plus `timestamp`, optional `stage`, optional `prUrl`.
- Diff (plain text): `.vanguard/runs/<taskId>/<sanitizedTs>[-<stage>].diff` (sibling; present only when non-empty).
- Transcript (raw): `.vanguard/runs/<taskId>/<sanitizedTs>[-<stage>].transcript.log` (sibling; present only when non-empty).
- Proof: `.vanguard/runs/<taskId>/<sanitizedTs>.proof.json` — `VerificationResult` (**no** stage suffix, one per run).
- `sanitizedTs` = `timestamp.replace(/[^0-9A-Za-z]/g, '-')`, e.g. `2026-07-06T19:12:02.123Z` → `2026-07-06T19-12-02-123Z`.
- A "run" = the set of stage records sharing an identical `timestamp` **field** (group by the field, not the filename).

Field shapes (camelCase JSON):
- `RunRecord`: `taskId:string, completed:bool, exitReason:string, turns:number, sessionId?:string, worktreePath:string, worktreePreserved:bool, finalText:string, usage?:{inputTokens,outputTokens,cacheReadInputTokens}, costUsd?:number, cacheEfficiency?:number, durationMs?:number, model?:string, timestamp:string, stage?:string, prUrl?:string`.
- `VerificationResult`: `command:string, exitCode:number, passed:bool, sha256:string, outputTail:string`.

---

## Task 1: Scaffold the Tauri 2 app at `apps/desktop/`

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/vite.config.ts`, `apps/desktop/index.html`, `apps/desktop/tsconfig.json`, `apps/desktop/tsconfig.node.json`, `apps/desktop/src/main.tsx`, `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`, `apps/desktop/src/test-setup.ts`
- Create: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/capabilities/default.json`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/.gitignore`

**Interfaces:**
- Produces: a buildable Tauri 2 app whose Rust entry point is `desktop_lib::run()`; a Vite frontend on port 1420; an `App` React component. Later tasks add commands to `lib.rs` and screens under `src/`.

This is a scaffolding task — its gate is "it builds and boots", not a unit test. Real TDD begins in Task 2.

- [ ] **Step 1: Create the Rust crate manifest** `apps/desktop/src-tauri/Cargo.toml`

```toml
[package]
name = "desktop"
version = "0.1.0"
description = "Vanguard Inspector"
edition = "2021"

[lib]
name = "desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
tempfile = "3"

[profile.release]
codegen-units = 1
lto = true
opt-level = 3
panic = "abort"
strip = true
```

- [ ] **Step 2: Create `apps/desktop/src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Create `apps/desktop/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "vanguard-desktop",
  "version": "0.1.0",
  "identifier": "dev.vanguard.desktop",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "title": "Vanguard Inspector", "width": 1100, "height": 800 }],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"]
  }
}
```

> `generate_context!` needs a real app icon or `cargo` won't compile. Generate `src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png` — from a source PNG via `pnpm tauri icon <src.png>`, or a solid-color placeholder for the scaffold. (`.icns`/`.ico` are only needed for `tauri build` bundling, not `cargo test`/`tauri dev`.)

- [ ] **Step 4: Create `apps/desktop/src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

- [ ] **Step 5: Create `apps/desktop/src-tauri/src/main.rs`**

```rust
// Prevents an extra console window on Windows in release. DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_lib::run()
}
```

- [ ] **Step 6: Create `apps/desktop/src-tauri/src/lib.rs` (commands added in Task 3)**

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: Create `apps/desktop/src-tauri/.gitignore`**

```gitignore
/target
/gen/schemas
```

- [ ] **Step 8: Create the frontend `apps/desktop/package.json`**

```json
{
  "name": "vanguard-desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "@tauri-apps/api": "^2",
    "chunks-ui": "^0.1.4",
    "@base-ui/react": "^1.6.0",
    "class-variance-authority": "^0.7.1",
    "motion": "^12"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@vitejs/plugin-react": "^5",
    "@tailwindcss/vite": "^4",
    "tailwindcss": "^4",
    "typescript": "~5.9.0",
    "vite": "^7",
    "vitest": "^3",
    "jsdom": "^25",
    "@testing-library/react": "^16",
    "@testing-library/dom": "^10",
    "@testing-library/jest-dom": "^6",
    "@types/react": "^19",
    "@types/react-dom": "^19"
  }
}
```

> `chunks-ui` (published, `0.1.4`) declares `motion`, `@base-ui/react`, and `class-variance-authority` as peers — they're listed above so `vite build` (rollup) can resolve chunks-ui's internal imports. (Vitest alone won't catch a missing peer if the dynamic import isn't triggered; the production build will.)

- [ ] **Step 9: Create `apps/desktop/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vanguard Inspector</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 10: Create `apps/desktop/vite.config.ts`**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.ts' },
});
```

- [ ] **Step 11: Create `apps/desktop/tsconfig.json` and `apps/desktop/tsconfig.node.json`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 12: Create `apps/desktop/src/styles.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 13: Create `apps/desktop/src/test-setup.ts`**

```ts
import '@testing-library/jest-dom';
```

- [ ] **Step 14: Create `apps/desktop/src/App.tsx` (placeholder shell, replaced in Task 7)**

```tsx
export default function App() {
  return <main className="p-4">Vanguard Inspector</main>;
}
```

- [ ] **Step 15: Create `apps/desktop/src/main.tsx`**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import 'chunks-ui/theme.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 16: Install and verify the frontend builds**

Run: `cd apps/desktop && pnpm install && pnpm build`
Expected: install completes; `tsc && vite build` succeeds; a `dist/` directory is produced.

- [ ] **Step 17: Verify the Rust crate compiles and its (empty) test target runs**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: compiles; `running 0 tests ... test result: ok. 0 passed`.

- [ ] **Step 18: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): scaffold Tauri 2 + React 19 + chunks-ui app shell"
```

---

## Task 2: Rust data layer — parse and group `.vanguard/runs` (pure, unit-tested)

**Files:**
- Create: `apps/desktop/src-tauri/src/runs.rs`
- Test: inline `#[cfg(test)] mod tests` in `runs.rs`

**Interfaces:**
- Produces (consumed by Task 3):
  - `pub fn list_run_summaries(repo_path: &std::path::Path) -> std::io::Result<Vec<RunSummary>>`
  - `pub fn read_run_detail(repo_path: &std::path::Path, task_id: &str, timestamp: &str) -> std::io::Result<RunDetail>`
  - `pub fn sanitize_timestamp(ts: &str) -> String`
  - serializable structs `RunRecord`, `AgentUsage`, `Proof`, `RunSummary`, `StageDetail`, `RunDetail`.

- [ ] **Step 1: Write the failing test** — create `apps/desktop/src-tauri/src/runs.rs` with the types, empty function stubs, and tests:

```rust
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub task_id: String,
    pub completed: bool,
    pub exit_reason: String,
    pub turns: u32,
    pub session_id: Option<String>,
    pub worktree_path: String,
    pub worktree_preserved: bool,
    pub final_text: String,
    pub usage: Option<AgentUsage>,
    pub cost_usd: Option<f64>,
    pub cache_efficiency: Option<f64>,
    pub duration_ms: Option<f64>,
    pub model: Option<String>,
    pub timestamp: String,
    pub stage: Option<String>,
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub command: String,
    pub exit_code: i32,
    pub passed: bool,
    pub sha256: String,
    pub output_tail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub task_id: String,
    pub timestamp: String,
    pub stages: Vec<String>,
    pub total_cost_usd: f64,
    pub any_failed: bool,
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDetail {
    pub record: RunRecord,
    pub diff: Option<String>,
    pub transcript: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub task_id: String,
    pub timestamp: String,
    pub stages: Vec<StageDetail>,
    pub proof: Option<Proof>,
}

fn runs_dir(repo_path: &Path) -> std::path::PathBuf {
    repo_path.join(".vanguard").join("runs")
}

/// Mirror of Vanguard's `timestamp.replace(/[^0-9A-Za-z]/g, '-')`.
pub fn sanitize_timestamp(ts: &str) -> String {
    ts.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn is_run_record_file(name: &str) -> bool {
    name.ends_with(".json")
        && !name.ends_with(".proof.json")
        && !name.ends_with(".visual-proof.json")
}

pub fn list_run_summaries(_repo_path: &Path) -> io::Result<Vec<RunSummary>> {
    Ok(Vec::new())
}

pub fn read_run_detail(_repo_path: &Path, _task_id: &str, _timestamp: &str) -> io::Result<RunDetail> {
    Ok(RunDetail {
        task_id: _task_id.to_string(),
        timestamp: _timestamp.to_string(),
        stages: Vec::new(),
        proof: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn fixture(repo: &Path) {
        let dir = repo.join(".vanguard/runs/task-7");
        write(
            &dir.join("2026-07-06T19-12-02-123Z-implement.json"),
            r#"{"taskId":"task-7","completed":true,"exitReason":"completed","turns":12,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"did it",
                "usage":{"inputTokens":1000,"outputTokens":500,"cacheReadInputTokens":800},
                "costUsd":0.12,"cacheEfficiency":0.44,"durationMs":8123,"model":"claude-opus-4",
                "timestamp":"2026-07-06T19:12:02.123Z","stage":"implement","prUrl":"http://pr/1"}"#,
        );
        write(
            &dir.join("2026-07-06T19-12-02-123Z-review.json"),
            r#"{"taskId":"task-7","completed":true,"exitReason":"completed","turns":4,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"looks ok",
                "costUsd":0.05,"timestamp":"2026-07-06T19:12:02.123Z","stage":"review"}"#,
        );
        write(&dir.join("2026-07-06T19-12-02-123Z-implement.diff"), "diff --git a b\n+x");
        write(&dir.join("2026-07-06T19-12-02-123Z-implement.transcript.log"), "line1\nline2");
        write(
            &dir.join("2026-07-06T19-12-02-123Z.proof.json"),
            r#"{"command":"pnpm test","exitCode":1,"passed":false,"sha256":"deadbeef","outputTail":"1 test failed"}"#,
        );
    }

    #[test]
    fn sanitize_matches_vanguard() {
        assert_eq!(sanitize_timestamp("2026-07-06T19:12:02.123Z"), "2026-07-06T19-12-02-123Z");
    }

    #[test]
    fn groups_stages_into_one_run() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let out = list_run_summaries(tmp.path()).unwrap();
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert_eq!(s.task_id, "task-7");
        assert_eq!(s.stages, vec!["implement".to_string(), "review".to_string()]);
        assert!((s.total_cost_usd - 0.17).abs() < 1e-9);
        assert!(!s.any_failed);
        assert_eq!(s.pr_url.as_deref(), Some("http://pr/1"));
    }

    #[test]
    fn reads_detail_with_diff_transcript_proof() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let d = read_run_detail(tmp.path(), "task-7", "2026-07-06T19:12:02.123Z").unwrap();
        assert_eq!(d.stages.len(), 2);
        let implement = d.stages.iter().find(|s| s.record.stage.as_deref() == Some("implement")).unwrap();
        assert_eq!(implement.diff.as_deref(), Some("diff --git a b\n+x"));
        assert_eq!(implement.transcript.as_deref(), Some("line1\nline2"));
        let proof = d.proof.as_ref().unwrap();
        assert!(!proof.passed);
        assert_eq!(proof.exit_code, 1);
    }

    #[test]
    fn missing_runs_dir_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_run_summaries(tmp.path()).unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: `sanitize_matches_vanguard` and `missing_runs_dir_is_empty_not_error` pass; `groups_stages_into_one_run` and `reads_detail_with_diff_transcript_proof` FAIL (stubs return empty).

- [ ] **Step 3: Implement `list_run_summaries`** — replace the stub:

```rust
pub fn list_run_summaries(repo_path: &Path) -> io::Result<Vec<RunSummary>> {
    let runs = runs_dir(repo_path);
    let mut summaries: Vec<RunSummary> = Vec::new();

    let task_dirs = match fs::read_dir(&runs) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(summaries),
        Err(e) => return Err(e),
    };

    for task_entry in task_dirs {
        let task_entry = task_entry?;
        if !task_entry.file_type()?.is_dir() {
            continue;
        }
        let mut groups: BTreeMap<String, Vec<RunRecord>> = BTreeMap::new();
        for file in fs::read_dir(task_entry.path())? {
            let file = file?;
            let name = file.file_name().to_string_lossy().into_owned();
            if !is_run_record_file(&name) {
                continue;
            }
            let contents = fs::read_to_string(file.path())?;
            if let Ok(record) = serde_json::from_str::<RunRecord>(&contents) {
                groups.entry(record.timestamp.clone()).or_default().push(record);
            }
        }
        for (timestamp, records) in groups {
            let mut stages: Vec<String> = records
                .iter()
                .map(|r| r.stage.clone().unwrap_or_else(|| "run".to_string()))
                .collect();
            stages.sort();
            summaries.push(RunSummary {
                task_id: records[0].task_id.clone(),
                timestamp,
                stages,
                total_cost_usd: records.iter().filter_map(|r| r.cost_usd).sum(),
                any_failed: records.iter().any(|r| !r.completed),
                pr_url: records.iter().find_map(|r| r.pr_url.clone()),
            });
        }
    }

    summaries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(summaries)
}
```

- [ ] **Step 4: Implement `read_run_detail`** — replace the stub:

```rust
pub fn read_run_detail(repo_path: &Path, task_id: &str, timestamp: &str) -> io::Result<RunDetail> {
    let task_dir = runs_dir(repo_path).join(task_id);
    let mut stages: Vec<StageDetail> = Vec::new();

    for file in fs::read_dir(&task_dir)? {
        let file = file?;
        let name = file.file_name().to_string_lossy().into_owned();
        if !is_run_record_file(&name) {
            continue;
        }
        let path = file.path();
        let contents = fs::read_to_string(&path)?;
        let record: RunRecord = match serde_json::from_str(&contents) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if record.timestamp != timestamp {
            continue;
        }
        let path_str = path.to_string_lossy();
        let base = path_str.strip_suffix(".json").unwrap_or(&path_str);
        let diff = fs::read_to_string(format!("{base}.diff")).ok();
        let transcript = fs::read_to_string(format!("{base}.transcript.log")).ok();
        stages.push(StageDetail { record, diff, transcript });
    }

    stages.sort_by(|a, b| a.record.stage.cmp(&b.record.stage));

    let proof_path = task_dir.join(format!("{}.proof.json", sanitize_timestamp(timestamp)));
    let proof = fs::read_to_string(&proof_path)
        .ok()
        .and_then(|c| serde_json::from_str::<Proof>(&c).ok());

    Ok(RunDetail {
        task_id: task_id.to_string(),
        timestamp: timestamp.to_string(),
        stages,
        proof,
    })
}
```

> Security: `task_id` reaches `read_run_detail` from the frontend, so guard against path traversal. Add near `is_run_record_file`:
> ```rust
> fn is_safe_task_id(task_id: &str) -> bool {
>     !task_id.is_empty() && !task_id.contains('/') && !task_id.contains('\\')
>         && !task_id.contains("..") && !Path::new(task_id).is_absolute()
> }
> ```
> and at the top of `read_run_detail`: `if !is_safe_task_id(task_id) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid task id")); }`. (`timestamp` is already safe — it's run through `sanitize_timestamp`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: all tests PASS (including a traversal-rejection test).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/runs.rs
git commit -m "feat(desktop): rust data layer to parse and group .vanguard/runs"
```

---

## Task 3: Expose the data layer as Tauri commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `runs::list_run_summaries`, `runs::read_run_detail` (Task 2).
- Produces (called by Task 4 over IPC): commands `list_runs(repoPath)` → `RunSummary[]`, `read_run(repoPath, taskId, timestamp)` → `RunDetail`.

- [ ] **Step 1: Write a failing IPC-boundary test** — append to `apps/desktop/src-tauri/src/lib.rs` a test that builds a mock app and invokes the command, proving registration + arg deserialization. First add the `test` feature to dev-deps in `apps/desktop/src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
tauri = { version = "2", features = ["test"] }
```

Then write `lib.rs` with the module wired but the commands not yet registered, plus the test:

```rust
mod runs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;

    #[test]
    fn list_runs_is_registered_and_returns_empty_for_missing_dir() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![super::list_runs])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let res = tauri::test::get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "list_runs".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "repoPath": "/no/such/dir" })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        assert!(res.is_ok(), "invoke failed: {res:?}");
    }
}
```

> Note: `InvokeRequest`'s fields are the one version-sensitive spot in this plan. If the installed Tauri 2 minor rejects a field above, check `docs.rs/tauri/latest/tauri/webview/struct.InvokeRequest.html` and adjust field names — the test's intent (invoke `list_runs` with `{repoPath}` and assert `Ok`) does not change.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: FAIL to compile — `super::list_runs` does not exist.

- [ ] **Step 3: Add the command wrappers and register them** — replace the top of `lib.rs`:

```rust
mod runs;

use std::path::Path;

#[tauri::command]
async fn list_runs(repo_path: String) -> Result<Vec<runs::RunSummary>, String> {
    runs::list_run_summaries(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_run(
    repo_path: String,
    task_id: String,
    timestamp: String,
) -> Result<runs::RunDetail, String> {
    runs::read_run_detail(Path::new(&repo_path), &task_id, &timestamp).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_runs, read_run])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: all tests PASS (Task 2 tests + `list_runs_is_registered_and_returns_empty_for_missing_dir`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(desktop): expose list_runs and read_run tauri commands"
```

---

## Task 4: Typed IPC boundary — `vanguard-output.d.ts` + `ipc.ts`

**Files:**
- Create: `apps/desktop/src/vanguard-output.d.ts`
- Create: `apps/desktop/src/ipc.ts`
- Test: `apps/desktop/src/ipc.test.ts`

**Interfaces:**
- Consumes: the `list_runs` / `read_run` commands (Task 3).
- Produces (used by Tasks 5–7): types `RunSummary`, `RunDetail`, `StageDetail`, `RunRecord`, `Proof`, `AgentUsage`; functions `listRuns(repoPath): Promise<RunSummary[]>`, `readRun(repoPath, taskId, timestamp): Promise<RunDetail>`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/ipc.test.ts` (uses `mockIPC` to intercept `invoke` and asserts the camelCase args reach the command):

```ts
import { test, expect, afterEach, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { listRuns } from './ipc';
import type { RunSummary } from './vanguard-output';

afterEach(() => clearMocks());

test('listRuns forwards camelCase repoPath and returns typed summaries', async () => {
  const captured: Record<string, unknown> = {};
  const sample: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement'], totalCostUsd: 0.12, anyFailed: false },
  ];
  mockIPC((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return sample;
  });
  const out = await listRuns('/repo');
  expect(captured.cmd).toBe('list_runs');
  expect((captured.args as { repoPath: string }).repoPath).toBe('/repo');
  expect(out[0].taskId).toBe('task-7');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/ipc.test.ts`
Expected: FAIL — `./ipc` and `./vanguard-output` do not exist.

- [ ] **Step 3: Create `apps/desktop/src/vanguard-output.d.ts`**

```ts
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface RunRecord {
  taskId: string;
  completed: boolean;
  exitReason: string;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
  cacheEfficiency?: number;
  durationMs?: number;
  model?: string;
  timestamp: string;
  stage?: string;
  prUrl?: string;
}

export interface Proof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
}

export interface RunSummary {
  taskId: string;
  timestamp: string;
  stages: string[];
  totalCostUsd: number;
  anyFailed: boolean;
  prUrl?: string;
}

export interface StageDetail {
  record: RunRecord;
  diff?: string;
  transcript?: string;
}

export interface RunDetail {
  taskId: string;
  timestamp: string;
  stages: StageDetail[];
  proof?: Proof;
}
```

- [ ] **Step 4: Create `apps/desktop/src/ipc.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';
import type { RunSummary, RunDetail } from './vanguard-output';

export function listRuns(repoPath: string): Promise<RunSummary[]> {
  return invoke<RunSummary[]>('list_runs', { repoPath });
}

export function readRun(repoPath: string, taskId: string, timestamp: string): Promise<RunDetail> {
  return invoke<RunDetail>('read_run', { repoPath, taskId, timestamp });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/vanguard-output.d.ts apps/desktop/src/ipc.ts apps/desktop/src/ipc.test.ts
git commit -m "feat(desktop): typed IPC boundary mirroring persisted run shapes"
```

---

## Task 5: chunks-ui Card atom + `RunList` screen

**Files:**
- Create: `apps/desktop/src/components/atoms/Card.tsx`
- Create: `apps/desktop/src/features/inspector/RunList.tsx`
- Test: `apps/desktop/src/features/inspector/RunList.test.tsx`

**Interfaces:**
- Consumes: `RunSummary` (Task 4); chunks-ui `Card` compound component.
- Produces (used by Task 7): `<RunList runs={RunSummary[]} onSelect={(r: RunSummary) => void} />`; `<Card>{children}</Card>` atom.

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/features/inspector/RunList.test.tsx`:

```tsx
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunList } from './RunList';
import type { RunSummary } from '../../vanguard-output';

test('renders a selectable card per run with task id and failure marker', () => {
  const runs: RunSummary[] = [
    { taskId: 'task-7', timestamp: '2026-07-06T19:12:02.123Z', stages: ['implement', 'review'], totalCostUsd: 0.17, anyFailed: true },
  ];
  render(<RunList runs={runs} onSelect={() => {}} />);
  expect(screen.getByText(/task-7/)).toBeInTheDocument();
  expect(screen.getByText(/failed/)).toBeInTheDocument();
});

test('renders an empty-state when there are no runs', () => {
  render(<RunList runs={[]} onSelect={() => {}} />);
  expect(screen.getByText(/No runs found/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/RunList.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Create the Card atom** `apps/desktop/src/components/atoms/Card.tsx`

```tsx
import { Card as ChunksCard } from 'chunks-ui';
import type { ReactNode } from 'react';

export function Card({ children }: { children: ReactNode }) {
  return (
    <ChunksCard.Root>
      <ChunksCard.Content className="p-4">{children}</ChunksCard.Content>
    </ChunksCard.Root>
  );
}
```

- [ ] **Step 4: Create `apps/desktop/src/features/inspector/RunList.tsx`**

```tsx
import { Card } from '../../components/atoms/Card';
import type { RunSummary } from '../../vanguard-output';

export function RunList({
  runs,
  onSelect,
}: {
  runs: RunSummary[];
  onSelect: (r: RunSummary) => void;
}) {
  if (runs.length === 0) {
    return <div className="text-sm opacity-60">No runs found in .vanguard/runs.</div>;
  }
  return (
    <div className="space-y-2">
      {runs.map((r) => (
        <button
          key={`${r.taskId}:${r.timestamp}`}
          onClick={() => onSelect(r)}
          className="block w-full text-left"
        >
          <Card>
            <div className="font-semibold">
              {r.taskId}
              {r.anyFailed ? ' · ⚠ failed' : ''}
            </div>
            <div className="text-sm opacity-80">
              {r.timestamp} · {r.stages.join(', ')} · ${r.totalCostUsd.toFixed(2)}
            </div>
          </Card>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/RunList.test.tsx`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components apps/desktop/src/features/inspector/RunList.tsx apps/desktop/src/features/inspector/RunList.test.tsx
git commit -m "feat(desktop): chunks-ui Card atom and RunList screen"
```

---

## Task 6: `RunDetail` — proof gate, stage cards, diff, transcript

**Files:**
- Create: `apps/desktop/src/features/inspector/ProofGate.tsx`
- Create: `apps/desktop/src/features/inspector/StageCard.tsx`
- Create: `apps/desktop/src/features/inspector/DiffView.tsx`
- Create: `apps/desktop/src/features/inspector/TranscriptView.tsx`
- Create: `apps/desktop/src/features/inspector/RunDetail.tsx`
- Test: `apps/desktop/src/features/inspector/ProofGate.test.tsx`

**Interfaces:**
- Consumes: `RunDetail`, `StageDetail`, `Proof` (Task 4); `Card` atom (Task 5).
- Produces (used by Task 7): `<RunDetail detail={RunDetail} onBack={() => void} />`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/src/features/inspector/ProofGate.test.tsx`:

```tsx
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProofGate } from './ProofGate';

test('renders FAIL and the output tail when proof failed', () => {
  render(
    <ProofGate
      proof={{ command: 'pnpm test', exitCode: 1, passed: false, sha256: 'x', outputTail: '1 test failed' }}
    />,
  );
  expect(screen.getByText(/FAIL/)).toBeInTheDocument();
  expect(screen.getByText(/1 test failed/)).toBeInTheDocument();
});

test('renders PASS when proof passed', () => {
  render(
    <ProofGate
      proof={{ command: 'pnpm test', exitCode: 0, passed: true, sha256: 'x', outputTail: 'ok' }}
    />,
  );
  expect(screen.getByText(/PASS/)).toBeInTheDocument();
});

test('renders a skipped note when there is no proof', () => {
  render(<ProofGate />);
  expect(screen.getByText(/No proof/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/ProofGate.test.tsx`
Expected: FAIL — `./ProofGate` does not exist.

- [ ] **Step 3: Create `apps/desktop/src/features/inspector/ProofGate.tsx`**

```tsx
import type { Proof } from '../../vanguard-output';

export function ProofGate({ proof }: { proof?: Proof }) {
  if (!proof) {
    return <div className="text-sm opacity-60">No proof-of-work recorded.</div>;
  }
  const ok = proof.passed;
  return (
    <div className={`pl-3 border-l-4 ${ok ? 'border-success' : 'border-destructive'}`}>
      <div className="font-semibold">Proof of work: {ok ? 'PASS' : 'FAIL'}</div>
      <div className="text-sm">
        command: <code>{proof.command}</code> · exit {proof.exitCode}
      </div>
      <pre className={`mt-2 text-xs whitespace-pre-wrap ${ok ? '' : 'text-red-600'}`}>
        {proof.outputTail}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Create `apps/desktop/src/features/inspector/StageCard.tsx`**

```tsx
import { Card } from '../../components/atoms/Card';
import type { StageDetail } from '../../vanguard-output';

export function StageCard({ stage }: { stage: StageDetail }) {
  const r = stage.record;
  const seconds = r.durationMs ? Math.round(r.durationMs / 1000) : 0;
  return (
    <Card>
      <div className="font-semibold">
        {r.stage ?? 'run'} · {r.exitReason}
      </div>
      <div className="text-sm opacity-80">
        {r.turns} turns · {seconds}s
        {r.usage ? ` · ${r.usage.inputTokens}/${r.usage.outputTokens} tok` : ''}
        {r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ''} · {r.model ?? 'unknown model'}
      </div>
      <p className="mt-2 text-sm whitespace-pre-wrap">{r.finalText}</p>
    </Card>
  );
}
```

- [ ] **Step 5: Create `apps/desktop/src/features/inspector/DiffView.tsx`**

```tsx
export function DiffView({ diff }: { diff?: string }) {
  if (!diff) {
    return <div className="text-sm opacity-60">No diff captured.</div>;
  }
  return <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{diff}</pre>;
}
```

- [ ] **Step 6: Create `apps/desktop/src/features/inspector/TranscriptView.tsx`**

```tsx
export function TranscriptView({ transcript }: { transcript?: string }) {
  if (!transcript) {
    return <div className="text-sm opacity-60">No transcript.</div>;
  }
  return <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{transcript}</pre>;
}
```

- [ ] **Step 7: Create `apps/desktop/src/features/inspector/RunDetail.tsx`**

```tsx
import { ProofGate } from './ProofGate';
import { StageCard } from './StageCard';
import { DiffView } from './DiffView';
import { TranscriptView } from './TranscriptView';
import type { RunDetail as RunDetailT } from '../../vanguard-output';

export function RunDetail({ detail, onBack }: { detail: RunDetailT; onBack: () => void }) {
  const firstDiff = detail.stages.find((s) => s.diff)?.diff;
  const firstTranscript = detail.stages.find((s) => s.transcript)?.transcript;
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm underline">
        ← back
      </button>
      <h2 className="text-lg font-semibold">
        {detail.taskId} · {detail.timestamp}
      </h2>
      <ProofGate proof={detail.proof} />
      <div className="space-y-2">
        {detail.stages.map((s, i) => (
          <StageCard key={i} stage={s} />
        ))}
      </div>
      <section>
        <h3 className="font-semibold">Diff</h3>
        <DiffView diff={firstDiff} />
      </section>
      <section>
        <h3 className="font-semibold">Transcript</h3>
        <TranscriptView transcript={firstTranscript} />
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/features/inspector/ProofGate.test.tsx`
Expected: all three tests PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/features/inspector
git commit -m "feat(desktop): run detail — proof gate, stage cards, diff, transcript"
```

---

## Task 7: Wire `App` end-to-end and verify the seam

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `listRuns`/`readRun` (Task 4), `RunList` (Task 5), `RunDetail` (Task 6).
- Produces: the working slice — repo-path input → run list → run detail.

- [ ] **Step 1: Replace `apps/desktop/src/App.tsx`**

```tsx
import { useState } from 'react';
import { listRuns, readRun } from './ipc';
import { RunList } from './features/inspector/RunList';
import { RunDetail } from './features/inspector/RunDetail';
import type { RunSummary, RunDetail as RunDetailT } from './vanguard-output';

export default function App() {
  const [repoPath, setRepoPath] = useState('.');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setDetail(null);
    try {
      setRuns(await listRuns(repoPath));
    } catch (e) {
      setError(String(e));
    }
  };

  const open = async (r: RunSummary) => {
    setError(null);
    try {
      setDetail(await readRun(repoPath, r.taskId, r.timestamp));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-4">
      <h1 className="mb-3 text-xl font-bold">Vanguard Inspector — Inspector</h1>
      <div className="mb-4 flex gap-2">
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="repo path (contains .vanguard/)"
          className="flex-1 border px-2 py-1"
        />
        <button onClick={load} className="border px-3 py-1">
          Load
        </button>
      </div>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
      {detail ? (
        <RunDetail detail={detail} onBack={() => setDetail(null)} />
      ) : (
        <RunList runs={runs} onSelect={open} />
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify the frontend builds and all unit tests pass**

Run: `cd apps/desktop && pnpm build && pnpm vitest run`
Expected: `tsc && vite build` succeeds; all Vitest tests pass.

- [ ] **Step 3: Verify the Rust side is green**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: all tests pass.

- [ ] **Step 4: Manual end-to-end verification against real data**

First ensure there is a repo with `.vanguard/runs/` to point at. If none exists locally, generate fixture data:

```bash
mkdir -p /tmp/vg-demo/.vanguard/runs/task-7
cat > "/tmp/vg-demo/.vanguard/runs/task-7/2026-07-06T19-12-02-123Z-implement.json" <<'JSON'
{"taskId":"task-7","completed":true,"exitReason":"completed","turns":12,"worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"Implemented the feature.","usage":{"inputTokens":1000,"outputTokens":500,"cacheReadInputTokens":800},"costUsd":0.12,"cacheEfficiency":0.44,"durationMs":8123,"model":"claude-opus-4","timestamp":"2026-07-06T19:12:02.123Z","stage":"implement","prUrl":"http://pr/1"}
JSON
printf 'diff --git a/x b/x\n+hello\n' > "/tmp/vg-demo/.vanguard/runs/task-7/2026-07-06T19-12-02-123Z-implement.diff"
printf 'agent turn 1\nagent turn 2\n' > "/tmp/vg-demo/.vanguard/runs/task-7/2026-07-06T19-12-02-123Z-implement.transcript.log"
cat > "/tmp/vg-demo/.vanguard/runs/task-7/2026-07-06T19-12-02-123Z.proof.json" <<'JSON'
{"command":"pnpm test","exitCode":1,"passed":false,"sha256":"deadbeef","outputTail":"FAIL src/x.test.ts\n1 test failed"}
JSON
```

Run: `cd apps/desktop && pnpm tauri dev`
Then, in the window:
1. Type `/tmp/vg-demo` into the repo-path input, click **Load**.
   Expected: one run card — `task-7 · ⚠ failed`, subtitle `2026-07-06T19:12:02.123Z · implement · $0.12`.
2. Click the card.
   Expected: detail view — Proof of work: **FAIL** (red) with `1 test failed`; one stage card (`implement · completed`, `12 turns · 8s · 1000/500 tok · $0.12 · claude-opus-4`, final text); the diff (`+hello`); the transcript (`agent turn 1 / 2`).
3. Click **← back**.
   Expected: returns to the run list.

Record the result of this manual check (pass/fail with what you observed) in the commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): wire inspector slice end-to-end (repo path → run list → detail)"
```

---

## Definition of done

- `cd apps/desktop/src-tauri && cargo test` — all green.
- `cd apps/desktop && pnpm build && pnpm vitest run` — build succeeds, all tests green.
- `pnpm tauri dev` renders the run list and a run's proof/stages/diff/transcript from real `.vanguard/` files (Task 7 manual check).
- No process spawning, no filesystem watching, no `git` calls, no `.github/workflows/` edits.

## Deferred (explicitly out of this slice — next plans)

- P0 breadth: dashboard, project board/list (TanStack Table), Task-Source issue fetching, `react-router` + zustand, live `sessions/*.jsonl` tailing via `notify`.
- P1+: process control (`spawn_run`/`kill`), the workflow editor, remote viewing. These get their own specs/plans per the design doc.
