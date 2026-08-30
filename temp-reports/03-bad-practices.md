# Bad Practices & Anti-Patterns Audit

**Project:** `E:/project/ai assistant` (opencode GUI — Tauri v2 + React 19)
**Date:** 2026-08-30
**Scope:** `src/hooks/useOpencode.ts`, `src/lib/*.ts`, `src/components/*.tsx`, `src/api.ts`, `src/styles/*.css`, `src-tauri/src/*.rs`, `package.json`, `tsconfig.json`, `vite.config.ts`, `src/types.ts`
**Method:** Full file reads with line-accurate references. Every finding cites a real `file:line`.

---

## Overview

The codebase ships a good product, but it carries the classic cost of a single-author, fast-iteration Tauri app: one god hook, one god Rust file, a global `localStorage` + `window` event bus instead of a state layer, pervasive `any`, and ~30% duplicated boilerplate across persistence, shell invocation, and CSS glass. None of this blocks a release; all of it raises the price of the second and third year of changes (new feature touches 4 persistence sites; a key rename breaks silently; a blocked `any` hides a streaming regression).

**Counts:** 44 findings — 5 Critical, 11 High, 18 Medium, 10 Low.

| Severity | Meaning |
|----------|---------|
| **Critical** | Breaks type safety, data integrity, or security boundary; fix before next feature |
| **High** | Will cause bugs on the next edit to the area; high-interest debt |
| **Medium** | Slows every change to the area; routine debt |
| **Low** | Hygiene / naming / style; fix opportunistically |

---

## Summary Table

| # | File:Line | Bad Practice | Impact | Fix | Sev |
|---|-----------|--------------|--------|-----|-----|
| **GOD OBJECTS** |||||
| G1 | `src/hooks/useOpencode.ts:1-1778` | God hook — 1778 lines, ~25 responsibilities (sessions/SSE/permissions/questions/security/agents/models/variants/commands/busy/attention/undo/queue/drafts) | Any change risks unrelated regression; tests impossible; merge conflicts | Split into `useSessions`, `usePermissions`, `useQuestions`, `useSecurityMode`, `useAgentSelection` composed by `useOpencode` | **Critical** |
| G2 | `src/components/Composer.tsx:1-1223` | God component — composer + model picker + slash menu + find overlay + draft + auto-grow + voice + keyboard brain + attachment UI in one file | Unreadable; prop surface 30+ props; impossible to test input logic in isolation | Extract `useComposerInput`, `useComposerFind`, `useComposerKeyboard`, keep render thin | **Critical** |
| G3 | `src-tauri/src/lib.rs:1-2048` | God file — window/tray/hotkeys/job/sidecar/file-ops/plugins/voice/glass/IPC/cursor in one file | Rust compile time; unsafe review must scan 2k lines; sidecar change risks tray regression | Already has `mod browser/voice/git/...` — finish the split: move `wininput`, `webfocus`, `ipc_hook`, tray setup into their own modules | **High** |
| G4 | `src/components/GitPanel.tsx:1-963` | 963-line component owns diff, commit, push/pull, AI generation, polling, resize, menus | Same as G2; commit-logic change risks breaking resize handler | Extract `useGitStatus`, `useCommitGen`, `useGitActions` | **High** |
| G5 | `src/lib/themes.ts:1-1149` | Data + parser + DOM application in one 1137-line file | Theme data change touches logic; hard to add a new built-in | Split `themes.data.ts` (BUILTIN_LIST + tokens) vs `themes.ts` (parse/apply) | **Medium** |
| **DUPLICATION** |||||
| D1 | `src/hooks/useOpencode.ts:80-158`, `src/hooks/useProviders.ts:56-116`, `src/hooks/useSettings.ts:270-365`, `src/lib/workspace.ts:28-41`, `src/lib/drafts.ts:3-9`, `src/lib/recentModels.ts:5-14`, `src/lib/plugins.ts:144-185` | `localStorage` JSON parse/write + try/catch repeated 30+ sites with literal keys (`oc.*`) | Key rename breaks silently in N places; no validation; no migration path | One `src/lib/storage.ts` with `createJsonStore<T>(key, validate, fallback)` and `createStringSet/Map` helpers | **High** |
| D2 | `src/hooks/useOpencode.ts:539-560`, `src/lib/workspace.ts:43-55`, `src/components/Sidebar.tsx:104-131` | Workspace dedup/normalize (`seen Set`, `toLowerCase`, `slice(0,5)`) copy-pasted 3 times | Fix in one place, bug stays in others | Reuse `getAllWorkspaces()` from `workspace.ts` everywhere; delete duplicates | **High** |
| D3 | `src-tauri/src/lib.rs:436-473`, `510-537`, `555-583`, `586-614` | File-op commands share identical `empty path` guard + `explorer`/`xdg-open` branches x4 | Drift when one branch is fixed (e.g. quoting) | `fn ensure_path(p: &str)`, `fn reveal(path: &str)` helper; share `#[cfg(windows)]` branch | **Medium** |
| D4 | `src-tauri/src/lib.rs:192-273` repeated `TcpListener::bind` retry + `wait_for_port` + `try_wait` sleeps | Same retry/sleep pattern with 4 different delay constants (100/200/250/300ms) | Tuning one timeout leaves others stale | One `retry_with_backoff()` helper | **Medium** |
| D5 | `src/styles/composer.css:9-22`, `src/styles/chat.css:3-28`, `src/styles/layout.css:311-319` etc. | Glass surf gradient `linear-gradient(180deg, rgba(var(--surf-rgb)...` copy-pasted 9 times | Color edit needs 9 hunks; miss one → visual seam | `--surf-glass: linear-gradient(...)` single token in `tokens.css` | **Medium** |
| D6 | `src/styles/composer.css:650-669`, `966-985`, `src/styles/chat.css:88-107` etc. | Glass border `color-mix(in srgb, var(--accent) calc(0.XX * 100%), transparent)` literal repeated ~40 times | Same as D5 | Tokenize to `--accent-08/--accent-16/--accent-22` etc. | **Low** |
| D7 | `src/components/MessageList.tsx:17-24` vs `src/components/ToolBlock.tsx:100-107` | `parseAnsweredSummary` / `summaryPairs` identical regex `/"([^"]+)"\s*=\s*"([^"]+)"/g` | Bug fix in one misses the other | Single `src/lib/answeredSummary.ts` | **Medium** |
| D8 | `src/hooks/useOpencode.ts:1468-1506` vs `866-889` vs `1624-1684` | Session-cleanup block (clear `hiddenSessions`, `store.remove`, `permissionsRef`, `sessionSecurity`, `sessionAgents`, `queueCounts`…) copy-pasted for delete/received-delete/clear | Deleting a session can leak one map → stale badge | `function purgeSession(id)` single helper | **High** |
| D9 | `src/hooks/useProviders.ts:17-21` vs `src/hooks/useOpencode.ts:35-37` | `isReachable` / `isAgentReachable` identical logic (string + list .some) | Add variant check → fix only one | One `isSelectable(name, list)` in `src/lib/models.ts` | **Low** |
| D10 | `src/lib/workspace.ts:45-54` vs `src/hooks/useSettings.ts:278-293` | Workspace extras parsing / dedup / max-5 repeated | Same as D2 | Share helper | **Medium** |
| D11 | `src/lib/themes.ts:62-1045` + `src/hooks/useSettings.ts:24-81` | `DEFAULT_COLOR_SETS` palette duplicated between `themes.ts` FALLBACK and `useSettings.ts:24-81` | Theme tweak needs two edits; drift → preview vs actual mismatch | Import from single `themes.tokens.ts` | **Medium** |
| **TYPE SAFETY** |||||
| T1 | `src/hooks/useOpencode.ts:1` | `// @ts-nocheck` disables all type-checking for 1778 lines | Compiler blind to the biggest file; streaming, `any`, `null` bugs land silently | Remove; fix the ~20 errors it hides (typed SDK wrappers) | **Critical** |
| T2 | `src/api.ts:26-44`, `src/hooks/useOpencode.ts:378,445,613,1147`, `src/lib/sessionStore.ts:178-225`, `src/types.ts:53` | `any` used 60+ times (`args: any`, `obj: any`, `(client as any)`, `(m as any)`, `properties: any`) | Same as T1 in miniature; refactors don't rename through `any` | Type SDK wrappers (`client.session.messages` etc.) with `unknown` + narrow | **Critical** |
| T3 | `src/api.ts:26-44` | `wrap(obj: any): any` `Proxy` + `withDir(args: any)` — dynamic SDK patching without types | Workspace-dir omission is a silent bug; proxy hides method signature changes on SDK upgrade | Typed wrapper: `createWorkspaceClient(base, dir)` returning a mapped type | **High** |
| T4 | `src/types.ts:53` | `OpenCodeEvent = { type: string; properties: any }` + `PermAsk.type: string` loose stringly-typed events | Every event handler needs `as` casts; misspelled event type not caught | Discriminated union `OpenCodeEvent = {type:"permission.asked"; properties: PermPayload} | ...` | **High** |
| T5 | `tsconfig.json:7` | `skipLibCheck: true` hides type errors in SDK / Tauri types | See T1 | Keep but periodically run with `skipLibCheck:false` in CI | **Low** |
| T6 | `src/hooks/useProviders.ts:6` | `type OcClient = Awaited<ReturnType<typeof import("../api").opencode>>["client"]` — inferred client type from `any`-backed function | Gives false confidence; resolves to `any`-flavoured | Type the SDK client once in `api.ts` and import it | **Medium** |
| **COUPLING** |||||
| C1 | `src/hooks/useOpencode.ts:902-905`, `src/components/Composer.tsx:503-547`, `src/lib/workspace.ts:23-26` etc. | Ad-hoc global bus: `window.dispatchEvent(new CustomEvent("oc:..."))` used 18+ times across unrelated modules (file watcher, chat find, git, voice, settings, workspace) | Event name typo = silent no-op; no discoverability; listener leaks (see C2) | Single typed `src/lib/events.ts` bus with `on/off/emit<OcEvent>` | **High** |
| C2 | `src/components/Composer.tsx:404-414`, `552-654`, `660-723`, `src/components/Sidebar.tsx:115-130` | `window.addEventListener` without `[]` deps → effect re-runs every render (missing dep array or empty listener set recreated per render) | Listener churn / duplicate handlers; Composer keyboard brain rebinds on every render | Supply correct deps or extract to `useEvent` stable handlers | **Medium** |
| C3 | `src/components/Composer.tsx:132-174` | Prop surface 33 props (agents/variants/security/caps/voice/hotkeys/usage…) | Adding one chip touches ChatPage + every Composer test/mock; prop drilling | Grouped contexts: `ModelContext`, `AgentContext`, `SecurityContext` or a single `ComposerState` prop | **High** |
| C4 | `src/hooks/useOpencode.ts:42-53` vs `src/hooks/useProviders.ts:23-26` | `useOpencode` owns `agents`, `useProviders` owns `providers` — split by entity, not flow; both manage `session*` maps + `LAST_*` + `restore` refs with near-identical logic | Same restore/pin/prune bug appears twice; variant handling lives in the wrong owner | Unify per-session selection into one `useSessionPrefs<T>` helper | **Medium** |
| C5 | `src/api.ts:9-15` | Module-level `localStorage` read at import time (side effect) | SSR/test import crashes if `localStorage` absent; import order sensitive | Lazy `getInitialDirectory()` called inside `opencode()` | **Low** |
| C6 | `src/lib/plugins.ts:232-273` | Plugin host uses `URL.createObjectURL(new Blob([main.js]))` + `import(/* @vite-ignore */ url)` with no CSP/sandbox | Plugin code runs with full app privileges — any filesystem write is a full compromise (documented as "trusted" but not enforced) | At minimum, freeze `PluginApi` surface + warn in docs (already done); consider `iframe` or `Worker` sandbox later | **Low** |
| C7 | `src/components/MessageList.tsx:549-584`, `src/hooks/useOpencode.ts:653-809` | Direct `document.querySelectorAll(".find-hit")`/`.msg`/DOM tree-walking inside React components | Breaks with any DOM restructure; bypasses React | Keep find highlighting in a pure `highlightFindInHtml` / CSS-only path | **Medium** |
| **NAMING / HYGIENE** |||||
| N1 | `src/components/GitPanel.tsx:143-144`, `src/hooks/useOpencode.ts:199-201` | Module-level mutable `genIdRef`/`genSidRef` + refetch throttles via bare `useRef<number>` with magic `1000` | Not obvious it's global/cross-panel; race between two GitPanels impossible to spot | Name `commitGenCounter` and extract throttle helper `useThrottledFetch(ms)` | **Low** |
| N2 | `src/lib/hotkeys.ts:80-137` | `HOTKEY_META` all `group: "In the app"` — 15 entries share one bucket; `HOTKEY_ORDER` duplicates key list | Settings UI shows one undifferentiated block | Real groups `"Workspace"`, `"Sessions"`, `"Editor"` | **Low** |
| N3 | `src/lib/attachments.ts:3` | `export const MAX_FILE = 50 * 1024 * 1024` unexplained magic; comment says "gets rejected by providers anyway" but value not tied to provider | Raise/lower requires hunting | `MAX_FILE_MB = 50` + comment "capped by largest provider limit (see attachments.md)" | **Low** |
| N4 | `src/lib/sounds.ts:38-52` | Hardcoded 12 booleans + `volume: 0.6` magic; `KIND_TOGGLE` maps `erase`→`type` surreptitiously | New sound kind must edit 3 sites | One `SOUNDS: Record<SoundKind, {toggle, tone}>` table | **Low** |
| N5 | `src-tauri/src/lib.rs:103-139` | `workspace_file` / `read_saved_workspace` / `workspace_get` — three names for "read persisted workspace" at different layers | Reader chases 3 functions to understand one read | One `workspace::load(app)` public API | **Low** |
| **CSS ISSUES** |||||
| S1 | `src/styles/tokens.css:5-44`, `src/styles/layout.css:21-22`, `src/styles/sidebar.css:8-9`, `src/styles/chat.css:13-17` | Spacing unit is 6px by convention (AGENTS.md) but hard-coded as `6px`/`8px`/`12px`/`14px`/`16px` literals in 120+ rules — no `--space` var | "Spacing unit 6px" is a comment, not enforcement | `--s:6px` and use `calc(var(--s)*N)` | **Low** |
| S2 | `src/styles/layout.css:158-181`, `src/styles/sidebar.css:481-605` | Inline `style={{ maxWidth:140, overflow:"hidden"...}}` duplicated in Sidebar JSX 6 times instead of a class | Style change needs 6 edits | `.ws-title--clipped` class | **Low** |
| S3 | `src/styles/chat.css:357-386`, `src/tauri/browser.rs:527-555` | `!important` and `border-radius:0`(!) overrides scattered; TikTok overlay uses `!important` per declaration | Specificity arms race | Isolate TikTok CSS to its own shadow scope | **Medium** |
| **RUST ISSUES** |||||
| R1 | `src-tauri/src/lib.rs:509,563,599`, `src-tauri/src/pty.rs:65,82` | `state.0.lock().unwrap_or_else(|e| e.into_inner())` — poison-unwrap boilerplate copy-pasted 15+ times | Forgot once → panic on poisoned mutex (window resize + pty kill racing) | `fn lock<T>(m: &Mutex<T>) -> MutexGuard<T>` helper | **High** |
| R2 | `src-tauri/src/lib.rs:1418`, `1439`, `1453`, etc. | `let _ =` error suppression used 50+ times (including `w.set_focus()`, `w.hide()`, `child.kill()`) | Real failures (port bind, file write) vanish in logs | At least `eprintln!` or `debug_log` for non-trivial calls; keep `_ =` only for idempotent cleanup | **High** |
| R3 | `src-tauri/src/lib.rs:59-61`, `1013-1100`, `1139-1320` | `unsafe` blocks with raw `HWND`, `HANDLE` casts, `transmute` for WNDPROC, `zeroed()` — safety invariants only in comments | One wrong lifetime → UB that survives `cargo test` | Add `// SAFETY:` per block with explicit invariant; prefer `windows` safe wrappers where available | **High** |
| R4 | `src-tauri/src/lib.rs:436-473`, `1410-1425` | `b64` hand-rolled base64 + `.cur` packing — reinvents `base64` crate already in `pty.rs` | Extra code to audit; byte-order bug risk | Use `base64` crate already in deps | **Medium** |
| R5 | `src-tauri/src/lib.rs:458-537` | `file_write`, `file_create`, `file_delete`, `file_rename`, `file_duplicate` accept absolute user paths with no traversal/symlink check (unlike `plugin_remove` which does) | Arbitrary file write from plugin/voice path via `write_file` → full compromise | Canonicalize + `starts_with(workspace)` check (same as plugins) | **Critical** |
| R6 | `src-tauri/src/pty.rs:264-273`, `src-tauri/src/lib.rs:110-130` | Mutex guards held across `insert`/`remove` at two sites with slightly different ordering; `pty_spawn` even re-checks `map.len() >= MAX_TERMS` after `drop`+sleep | Race where two spawns pass the first check and both insert → 9th terminal | Single `try_insert` guarded method | **Medium** |
| R7 | `src-tauri/src/git.rs:32-48`, `src-tauri/src/browser.rs:280-423`, `src-tauri/src/lib.rs:357-422` | Sync `Command::output()` run on `#[tauri::command] async` via `async fn` without `spawn_blocking` — blocks the Tauri async thread pool | Burst of git status calls janks UI | Wrap in `tokio::task::spawn_blocking` (git comment claims async but `run()` is sync) | **Medium** |
| **CONFIG** |||||
| F1 | `package.json:39-41` | `allowScripts: { "esbuild@0.28.2": true }` — pins one version but CI may install another; no `engines` field | `npm install` with esbuild 0.28.3 runs as unsandboxed script unexpectedly | Use `engines: { node: ">=20" }` and dependabot for esbuild | **Low** |
| F2 | `vite.config.ts:18-41` | `manualChunks(id)` string-matching on `node_modules` paths — fragile to scoped package rename | Adding `hast-util-table` misses the `markdown` chunk rule | Use `import.meta` graph or at least a set test `/(hast|unified|micromark)/.test(id)` (already partly) | **Low** |
| F3 | `tsconfig.json:13` | `noEmit:true` + `allowImportingTsExtensions:true` — Vite handles emit, but `tsc --noEmit` in `run.ps1 check` still type-checks with TS extensions | Fine; no fix needed | — | — |
| — | `src/hooks/useOpencode.ts:1084-1089` | `// ponytail: nudge interval tuning lives here` — correct single-line `ponytail:` ceiling comment | — | Keep | — |

---

## Category Detail

### God Objects

#### G1 — `src/hooks/useOpencode.ts:1-1778` — God Hook

The largest frontend file by far. Responsibilities in one closure:

- boot polling + `resetOpencodeCache` retry (`921-945`)
- SSE fan-out per workspace (`653-980`, plus `EventSource` + interval polling for workspace list)
- sessions CRUD + hidden-session filtering + `applyOverrides` (`502-602`)
- message store mirroring + revert/visibleMsgs (`628-651, 1270-1328`)
- per-session busy/compacting + `busyTracker` integration (`189-238, 489-499`)
- permissions + questions + attention badges + auto-respond (`69-75, 379-454`)
- agents selection + disabled + per-session memory (`162-183, 288-376`)
- security mode with migration (`77-158`)
- command + agent registries + throttled file-watcher refresh (`201, 603-626, 899-916`)
- undo/revert/fork/duplicate/pin/rename/clear (`1270-1674`)
- queue + promptNow/send/flush (`1139-1202`)
- slash dispatch + cmdList (`1392-1465`)
- provider wrapper `prov.*` delegation (`189`)

**Fix:** Extract `useSessions`, `useSse`, `usePermissionQueue`, `useAgentPrefs`, `useSecurityMode`. `useOpencode` composes them and owns only the glue (activeId + flushRef). Aim for each hook ≤250 lines.

#### G2 — `src/components/Composer.tsx:1-1223` — God Component

Covers model picker logic (`739-806`), slash autocomplete (`459-483`), code-block highlight (`27-89`), find overlay (`190-446`), draft/history (`275-361`), auto-grow + scroll sync (`250-273`), drag-drop attachments (`848-863`), voice events (`496-547`), type-to-focus (`656-723`), keyboard brain (`549-654`), and render. The keyboard brain alone is a 120-line `useEffect` with `window.addEventListener("keydown", ...)` recreated every render (C2).

**Fix:** Pull `draftHtml` to `src/lib/composerHighlight.ts`, `useComposerFind`, `useComposerHistory`, `useComposerKeyboard`. Keep the component to props + JSX.

#### G3 — `src-tauri/src/lib.rs:1-2048`

Already delegates to `mod browser/voice/git/pty/...` but still keeps 900+ lines of window, tray, hotkeys, glass, IPC, input-poison repair, and `setup` in one file. The `run()` builder is 400+ lines (`1598-2046`). Any change to tray menu rebuilds the whole file in `cargo check`.

**Fix:** Move `wininput`, `webfocus`, `ipc_hook`, tray/JumpList, and `setup` into `src-tauri/src/window.rs`. `lib.rs` becomes `spawn_server` + glue.

#### G4 — `src/components/GitPanel.tsx:1-963`

Mixes polling, staged/changes derivation, commit generation (heuristic + AI staged session), commit-then-push/sync state machines, and rendering. The `genMessage` closure at `280-390` alone is 110 lines and captures `st`, `staged`, `gen*` refs.

#### G5 — `src/lib/themes.ts:1-1149`

`BUILTIN_LIST` (data) + `stripComments` + `parseThemesConfig` + `applyTheme` in one file. Data diffs pollute logic history.

---

### Duplication

#### D1 — Scattered `localStorage` boilerplate

Every key (`KEY`, `PINNED_KEY`, `TITLE_OVERRIDES_KEY`, `LAST_KEY`, `LAST_AGENT_KEY`, `SESSION_MODELS_KEY`, `oc.settings`, `oc.variants`, `oc.securityMode`, `oc.plugins.disabled`, `oc.recentModels`) repeats the same 4-line `try { JSON.parse(localStorage.getItem(k) ?? "{}") } catch { return {} }`. Search for `localStorage.getItem` — 34 hits across 12 files.

#### D3 — File-op commands

```rust
// src-tauri/src/lib.rs:436-473  (write_file, file_create, file_delete)
// src-tauri/src/lib.rs:510-537  (file_reveal)
// src-tauri/src/lib.rs:586-614  (reveal_plugins_dir)
if path.trim().is_empty() { return Err("empty path".into()); }
#[cfg(windows)] { use std::os::windows::process::CommandExt; ... }
```
The Windows `CommandExt` import + `CREATE_NO_WINDOW` const is repeated per function instead of once at module scope.

#### D5 / D6 — CSS glass literals

`rgba(var(--surf-rgb), min(1, calc(var(--surf-a) * 1.15)))` and `backdrop-filter: blur(10px)` appear in `composer.css`, `chat.css`, `layout.css`, `git.css`, `dialog.css`, `settings.css`. `color-mix(in srgb, var(--accent) ...` appears 42 times (count `grep -r color-mix src/styles`).

#### D8 — Session purge

```ts
// src/hooks/useOpencode.ts:866-889  (session.deleted SSE)
// src/hooks/useOpencode.ts:1468-1506 (removeSession)
// src/hooks/useOpencode.ts:1624-1674 (clearSessionsFor / clearSessions)
sessionDirRef.current.delete(id); store.remove(id); tracker.reset(id);
questionsRef.current.delete(id); permissionsRef.current.delete(id);
clearAttention(id); markCompacting(id,false); clearDraft(id);
setSessionSecurity(...); setSessionAgents(...); prov.rememberSession(id,"");
```

Three copies; a new map (`sessionVariants` was missed in the SSE path before the recent fix) shows the drift.

---

### Type Safety

#### T1 — `src/hooks/useOpencode.ts:1: // @ts-nocheck`

The single largest file opts out of the type system entirely. The file has 30+ `(client as any)`, `(m as any)` casts that would otherwise be caught, but the opt-out hides new ones too. CI's `run.ps1 check` (`tsc --noEmit`) green-lights it even when a streaming `Msg` shape changes.

#### T2 — `any` diffusion

`src/api.ts:26 wrap(obj: any, dir?: string): any` returns a `Proxy` cast as the SDK client. Callers get autocompletion from the declared `createOpencodeClient` return, but the directory injection and `path/body/query` shapes are `any`, so a misspelled `path: { id }` vs `path: { sessionID }` passes `tsc` and fails at runtime. Similar density in `types.ts:53 properties: any`, `sessionStore.ts` internals, `slashCommands.ts` `st: any`.

#### T3 / T4 — Event typing

All `oc:*` events and SSE `OpenCodeEvent` are `string`/`any`. A rename `permission.asked` → `permission.v2.asked` required a fallback chain at `705-754` rather than a compiler error. Discriminated union on `e.type` would make exhaustiveness checks catch a missing case.

---

### Coupling

#### C1 — Global `CustomEvent` bus

18 distinct `oc:*` events (`oc:file-changed`, `oc:plugin-slash`, `oc:composer-find`, `oc:chat-find-clear`, `oc:rewind-input`, `oc:workspaces-changed`, `oc:last-workspace-changed`, `oc:debrief`, `oc:voice-*`, `oc:git`, etc.) form an implicit pub/sub without a registry. Two consequences: (1) a typo `oc:chat-find-clear` vs `oc:chat-find:clear` fails silently; (2) ordering matters but is undocumented — e.g. `oc:rewind-input` must fire after `openSession` completes or the draft is overwritten (`useOpencode.ts:1314` + `Composer.tsx:531`).

#### C2 — Re-binding window listeners every render

```ts
// src/components/Composer.tsx:552  useEffect(() => { window.addEventListener("keydown", onKey); })
//  no dependency array — runs on *every* render, removing and re-adding the global handler
```

Same for the `onTypeToFocus` capture listener at `658`. Any in-flight key processed during the swap can be dropped. Use `useCallback` + stable deps or a single `useLayoutEffect` with refs.

#### C3 — Prop drilling

`Composer`'s 33 props are forwarded one-by-one from `ChatPage.tsx`. Adding `onToggleTerm` or `cycleAgentHotkey` touches 3 files. `ChatPage` already holds `useOpencode()` + `useProviders()`; a `ComposerState` context or passing `opencode` directly would collapse the surface.

#### C5 — Import-time side effect

`src/api.ts:9-15` reads `localStorage` at module evaluation. In a test harness or worker where `localStorage` is not yet polyfilled, the import itself throws. Defer to a lazy getter.

---

### CSS Issues

#### S1 — Spacing unit not tokenized

`AGENTS.md:59` says "Spacing unit: 6px" but no `--space` variable exists. A `6px` → `8px` system change would require `grep` + ~80 edits. Current values (`6px`, `8px`, `12px`, `14px`, `18px`, `22px`, `32px`) are not even multiples of 6.

#### S2 — Inline `style={{}}` in JSX

Sidebar workspace rows repeat the same truncation triple (`maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"`) in 6 inline styles (`Sidebar.tsx:405,440`). Should be a single class.

#### S3 — Specificity debt

TikTok overlay at `src-tauri/src/browser.rs:527-555` and `src/styles/browser.css` use `!important` per line; `chat.css:330 .revert-banner` uses stacked selectors to override `.msg`. Add a scoped container instead.

---

### Rust Issues

#### R1 — Poison unwrap boilerplate

`lock().unwrap_or_else(|e| e.into_inner())` is the correct poison-handling idiom but copy-pasting it 15+ times is the wrong place to be correct. A missed site reintroduces `unwrap()` panic on a poisoned mutex (easy during a panic + pty kill).

```rust
// src-tauri/src/lib.rs helpers — example fix
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
```

#### R2 — `let _ =` swallowing errors

`let _ = w.hide(); let _ = w.show(); let _ = child.kill();` — 50+ silenced `Result`s. Most are intentionally best-effort, but the same pattern is used for fallible ops like `std::fs::write(&file, t)` in `workspace_set` and `theme_config_write` where the caller should surface the error (and in fact `theme_config_write` *does* return it — inconsistency).

#### R3 — `unsafe` review burden

`lib.rs` has ~25 `unsafe` blocks: `CreateJobObjectW`, `Handle` transmutation, `SetWindowSubclass`, `GetCursorPos`, user32 `extern "system"` shims. Each is locally sound but scattered among safe code; an `unsafe` audit must read the whole 2k-line file. Centralize into `src-tauri/src/win.rs` with `// SAFETY:` invariants per function.

#### R4 — Hand-rolled `b64`

`b64(d: &[u8]) -> String` at `lib.rs:1411-1423` reimplements RFC 4648 while `base64 = "0.22"` is already in `Cargo.toml` (used in `pty.rs:181`). One place to maintain instead of two.

#### R5 — File ops lack path validation (Critical)

`write_file`, `file_create`, `file_delete`, `file_rename`, `file_duplicate` take an absolute `path: String` from the frontend and call `std::fs::write/remove` directly. No canonicalization or `starts_with(workspace)` check, unlike `plugin_remove` which does:

```rust
// src-tauri/src/lib.rs:630-634 — plugins DO check
let canon_plugins = plugins_dir().canonicalize().unwrap_or_else(|_| plugins_dir());
let canon_target = target.canonicalize().map_err(|e| e.to_string())?;
if !canon_target.starts_with(&canon_plugins) { return Err("invalid plugin path".into()); }
```

`FileTree` supplies paths inside the workspace, but `Composer` drag-drop and `file_open`/`write_file` accept any frontend string, and the Tauri invoke boundary is the trust boundary. Fix is the same `canonicalize` + `starts_with` guard.

#### R7 — `async` commands blocking

`#[tauri::command] pub async fn git_status(...)` calls `Command::output()` synchronously. `async` here only moves the work off the main thread onto Tauri's thread pool; the sync `output()` still blocks that pool thread for the duration of `git status`. With polling (`GitPanel:491 setInterval(4000)`) plus SSE, a burst can saturate the pool. Wrap `run()` body in `tokio::task::spawn_blocking`.

---

### Config

#### F1 / F2 — Minor

`package.json` lacks `engines`; `vite.config.ts:18-40` `manualChunks` is fragile to new `hast-*` packages — consider `id.includes("hast-util")` already done, but the block duplicates the comment about circular deps and could be a `Set` test.

---

## Severity-Ordered Priority

**Do first (Critical):**
- G1, T1, T2, R5, G2 — god hook + type opt-out + arbitrary file write + god component are the highest-interest debt.

**Do next (High):**
- D1, D8, G3, C1, C3, R1-R3, D2, T3-T4

**Do when in the area (Medium):**
- G5, D3-D5, D7, D10-D11, S3, R4, R6-R7, C2, C4, C7, T6

**Opportunistic (Low):**
- D6, D9, S1-S2, N1-N5, F1-F2, T5, C5-C6

---

## Notes

- `vite.config.ts:15 chunkSizeWarningLimit:3600` is intentional (lazy `dict` chunk) — not a finding.
- `src-tauri/src/browser.rs` lock discipline comments and `async` on every Tauri command are correct; only `git.rs`'s sync `run()` inside `async` is the mismatch (R7).
- No new dependencies recommended for any fix; `base64` is already present (R4), `R` style fixes are stdlib.
