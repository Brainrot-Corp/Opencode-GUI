# 04 — Nonsensical / Confusing / Dead Code Audit

**Date:** 2026-08-30
**Scope:** `src/hooks/useOpencode.ts`, `src/lib/*.ts`, `src/components/*.tsx`, `src/pages/ChatPage.tsx`, `src/api.ts`, `src-tauri/src/lib.rs`, `src/styles/*.css`, orphaned files, TODO/HACK comments
**Mode:** read-only audit — no fixes applied
**Method:** full file reads, cross-reference imports, grep for `TODO|FIXME|HACK|@ts-nocheck|console.|void `, manual control-flow tracing

## Overview

The codebase is functional but carries a high **accidental complexity budget**: the same concern is solved 2–3 times (`workspace` / `directory` / `oc.settings.workspace` → Rust file → `localStorage`), error banners are copy-pasted, and the Tauri-Rust window-focus repair is ~500 LOC of raw Win32 that re-implements what `tauri-plugin-window-state` + `webview2-com` could cover. No single file is broken, but the *interaction* between files is hard to reason about — a newcomer must hold 4 `localStorage` keys, 2 `Map<string,Set>` and a `Proxy`-wrapped SDK in their head to trace a single prompt.

**Counts:** 38 findings — 5 Dead Code, 9 Contradictory Logic, 5 Confusing Naming, 8 Inconsistent Patterns, 7 Overengineering, 4 Orphaned/Commented.

> Severity: 🔴 High — will bite soon · 🟠 Medium — slows comprehension/bugs likely · 🟡 Low — cleanup · ⚪ Note

---

## Summary Table

| # | File:Line | Issue | Why Confusing | Suggestion | Severity |
|---|-----------|-------|---------------|------------|----------|
| D1 | `src/lib/clipboard.ts:54` | `export async function clipboardHasText()` never imported anywhere | Dead export inflates API surface; search shows zero callers | Delete or use in `SelectionMenu`/`Composer` paste guard | 🟡 Low |
| D2 | `src/hooks/useOpencode.ts:301` | `void rememberAgentSession;` standalone no-op expression | Reads like forgotten code; `void` on a value does nothing — likely meant to silence unused var lint but variable *is* used | Remove line; if needed, use `_ = rememberAgentSession` or eslint disable | 🟡 Low |
| D3 | `src/lib/drafts.ts:27` | `clearDraft(sid)` is just `setDraft(sid,"")` alias | Two names for same operation; callers mix `clearDraft(delId)` and `setDraft(id,"")` arbitrarily | Keep one; replace callers of `clearDraft` with `setDraft(sid,"")` or vice-versa | 🟡 Low |
| D4 | `src/lib/editorKeys.ts:461-493` | Self-test gated on `process.argv[1].endsWith("editorKeys.ts")` with `console.log` | Ships to browser bundle; `process` undefined in WebView2 — dead in prod but adds 32 lines and a confusing runtime branch | Move to `src/lib/editorKeys.test.ts` or gate on `import.meta.vitest` | 🟡 Low |
| D5 | `src/main.tsx:63-73` | `window.addEventListener("error")` + `console.error` monkey-patch both call `invoke("debug_log")` with `%TEMP%\oc-gui-debug.log` — comment says "TEMP diagnostics … remove once crash is fixed" (`src-tauri/src/lib.rs:1395`) | Leaves permanent file logging in release; `console.error` wrapper can recurse if `invoke` itself logs via console | Remove before release or feature-gate on `import.meta.env.DEV` | 🟠 Medium |
| C1 | `src/api.ts:63-91` | `opencode()` triple retry/clear: `cached = attempt().catch(retry).catch(clear).catch(clear)` plus `cached.catch(()=>cached=null)` | Hard to tell which `catch` wins; concurrent callers before first resolve share a rejected `cached` Promise, retry races, and `cached=null` in both inner and outer catch is duplicated | Collapse to one retry helper; store only resolved `{base,client}` or null; use `let inflight` not cached rejected promise | 🔴 High |
| C2 | `src/api.ts:33-43` | `wrap()` Proxy recursively wraps every object property; `get(t,prop)` returns `wrap(v,d)` for objects | Every property access creates new Proxy wrapper; breaks `instanceof`, `Object.keys`, and leaks proxies; `withDir(a[0],d)` assumes first arg is options object — wrong for positional APIs | Generate typed wrapper per SDK namespace explicitly instead of Proxy; or memoize proxy per object | 🟠 Medium |
| C3 | `src/hooks/useOpencode.ts:1` | `// @ts-nocheck` disables all type checking for 1778-line core hook | Contradicts `tsc --noEmit` in `run.ps1 check`; silently allows `(client.session as any)` and `store.cached` mismatches to compile | Remove; add narrow `// @ts-expect-error` where SDK types lag (`file.watcher.updated`, `question` endpoints) | 🔴 High |
| C4 | `src/hooks/useOpencode.ts:43-52` + `src/hooks/usePlugins.ts:21-29` + `src/hooks/useSettings.ts:381-389` | Identical `setError` queueMicrotask toggle pattern copy-pasted 3 times | Magic to re-trigger banner when same message repeats; duplicated verbatim, easy to drift; reader must reverse-engineer | Extract to `src/lib/banners.ts: createBanner()` helper | 🟠 Medium |
| C5 | `src/hooks/useOpencode.ts:704-810` | Permission events have 6 cases: `permission.asked`, `permission.v2.asked`, `permission.updated`, `permission.replied`, `permission.v2.replied`, plus `permission.v2.replied` vs `permission.replied` with different fields (`permission` vs `action` vs `type`, `metadata.command` vs `title` vs `patterns`) | Same ask handled 3 different shapes; auto-respond path (`mode==="full"|"block"`) duplicated in event handler *and* boot fetch (`handleBootPerms`) | Normalize once: `function toPermAsk(p): PermAsk\|null` and early return; dedupe v2 vs v1 at parse boundary | 🟠 Medium |
| C6 | `src/hooks/useOpencode.ts:921-1055` | Boot loop `while(!disposed){ list=await withDeadline(refreshSessions(),12000)}` + 30s outer timeout + `resetOpencodeCache()` on catch + `esMap` + `setInterval` stored via `(esMap as any)._interval` + 3 `serverFetch("/question"|"/permission"|"/api/permission/request")` fallbacks | Mixing polling, deadline, cache invalidation, and SSE setup in one 130-line IIFE; storing interval on Map via cast hides leak; permission fallbacks parse 3 endpoint shapes | Split boot into `await waitForServer()` and `setupSSE(dirs)`; store interval in `let wsPoll` not on Map | 🟠 Medium |
| C7 | `src/hooks/useOpencode.ts:628-651` | `openSession` does `store.cached(id)` → `beginFetch(id)` → `client.session.messages` → `if(isStale)return` → `if(busyRef.current.has(id))return` | The `busy` guard *after* fetch means mid-stream store is newer than fetched snapshot, but the early `setMsgs([...cached])` already flashed stale-ish cached data before fetch — user sees flicker | Check `busy` *before* optimistic `setMsgs`, or keep cached until fetch settles when busy | 🟡 Low |
| C8 | `src/hooks/useOpencode.ts:217-238` | `trackerRef` created with `onSettle: (sid)=>{ tracker.markBusy...}` where `tracker` is the same ref being assigned | Closure captures `tracker` variable before assignment — works only because `onSettle` not called synchronously during construction; fragile | Create `tracker` first with `let tracker; tracker=createBusyTracker({onSettle:sid=>tracker.markBusy})` or pass `setBusy` directly without referencing self | 🟡 Low |
| C9 | `src/lib/sessionStore.ts:10` | `new Map<string, {sid:string;parts:Part[]}>(new Map())` — wrapping `new Map()` in `new Map()` | No-op double construction; looks like leftover from generic param edit | `new Map<string, {sid:string;parts:Part[]}>()` | 🟡 Low |
| C10 | `src/lib/sessionStore.ts:76-106` | `applyMessage` deletes `pendingDeltas` for queued parts (authoritative), but `applyPart` does *not* flush deltas; `flushDeltas()` only called from `applyMessage` | If deltas arrive between `applyPart` and next `applyMessage`, they stash forever until next message event — text appears late or duplicated | Call `flushDeltas()` at end of `applyPart` success path as well | 🟠 Medium |
| N1 | `src/hooks/useOpencode.ts:80-158` + `src/hooks/useProviders.ts:151-205` | 4 copies of "per-session override + global last + localStorage sync + restoring flag + cross-window storage event" for securityMode / agentSel / modelSel / variantSel | Same 60-line pattern repeated; names diverge (`restoringSecRef` vs `restoringAgentRef` vs `restoringRef`) making diffs noisy | Extract `createPerSessionOverride({key, sessionKey, validate})` hook factory | 🟠 Medium |
| N2 | `src/lib/plugins.ts:199-218` | `active: Map<string,{url,style}>` stores same object under both `dir` and `id` (alias), `revokeActive` must loop `for([k,v] of active)` to delete both | Aliasing makes ownership unclear; `active.get(id)` may return dir-keyed entry and vice versa — easy to leak blob URLs | Store `Map<dir, Entry>` only; resolve alias at lookup via `dirById` map | 🟠 Medium |
| N3 | `src/hooks/useOpencode.ts:538-600` | `refreshSessionsFor(dir)` vs `refreshSessions()` vs `getAllDirs()` vs `getWorkspaces()` vs `src/lib/workspace.ts:getAllWorkspaces()` — 3 places compute deduped `[primary,...extras]` with `toLowerCase()` dedupe | Reader must check which one preserves order/casing; `refreshSessions` rebuilds `sessionDirRef` twice (nextMap → finalMap) with subtle "preserve pending creations" loop | Single `src/lib/workspace.ts:getAllWorkspaces()` source; `useOpencode` imports it instead of reimplementing | 🟠 Medium |
| N4 | `src/components/Sidebar.tsx:21-26` + `src/lib/workspace.ts:28-42` | `getWsCollapsed()` / `setWsCollapsed()` vs `getTitleOverrides()`/`getPinned()`/`getPinned` — identical `try{ JSON.parse(localStorage.getItem(key))}catch{return {}}` pattern with different defaults | Naming inconsistent (`WsCollapsed` vs `PINNED_KEY` `oc.pinnedSessions` vs `TITLE_OVERRIDES_KEY` vs `SB_W_KEY` `oc.sb.w`) — no central registry | Centralize keys in `src/lib/storageKeys.ts` and create `getJson(key, fallback)` helper | 🟡 Low |
| N5 | `src/lib/syntax.ts:37-38` vs `src/hooks/useOpencode.ts:1084` | `MAX_AUTO=20_000`/`MAX_KNOWN=150_000` with comment "ponytail: … only if real files ever hit this" vs `settling nudge 10_000ms ponytail` vs `variant ponytail` | Ponytail comments sometimes mark real debt (O(n²) scan), sometimes trivial caps — inconsistent signal | Reserve `ponytail:` for load-bearing shortcuts only; move tuning notes to plain comments | 🟡 Low |
| I1 | `src/api.ts:7-15` | Module-level `let directory=""` initialized via `JSON.parse(localStorage.getItem("oc.settings"))` at import time; `setDirectory()` mutates module var; `workspace.ts:applyWorkspace()` also writes `localStorage` + `invoke("workspace_set")` + mutates same var via `setDirectory` | Three sources of truth (module var, localStorage, Rust file) hydrated in `main.tsx:hydrateWorkspace()` with three-way divergence logic; easy to get out of sync on reload | Make `directory` a getter (`function getDirectory(){return JSON.parse(...).workspace??""}`) or single store with subscription | 🔴 High |
| I2 | `src/hooks/useSettings.ts:243-376` | `loadColors(p, legacyTheme)` handles flat `p.colors.base` migration, but `themes.ts:FALLBACK` already supplies same vars; `useSettings` also duplicates entire `DEFAULT_COLOR_SETS` (14 themes ×2 modes) that already lives in `themes.ts:BUILTIN_LIST` | Palette defined twice; editing one without the other silently diverges (e.g., `abyss` light `--accent` differs between files if one updated) | Source palettes from single file (`themes.ts` exports `BUILTIN_COLORS` reused in `useSettings`) | 🟠 Medium |
| I3 | `src/hooks/useOpencode.ts:503-535` | `applyOverrides(list)` reads `localStorage` for `TITLE_OVERRIDES` and `PINNED` on *every* `setSessions` call (including SSE `session.updated`) and re-dedupes+sorts | Synchronous `localStorage.getItem` + `JSON.parse` on hot path (every typing delta triggers re-render check? not directly, but every session event re-reads disk) vs `useProviders` which caches `variantMap` in state | Hoist overrides into React state refs like `sessionAgentsRef`, update via storage events | 🟡 Low |
| I4 | `src/lib/recentModels.ts:3` `const MAX=5` vs `src/lib/workspace.ts:5` `const MAX_EXTRA=5` vs `src-tauri/src/lib.rs` workspace handling `5` hard-coded elsewhere | Same limit 5 repeated under different names; changing one doesn't change others | Export `MAX_WORKSPACES=5` from `workspace.ts` and import in `useOpencode.ts:getWorkspaces()` | 🟡 Low |
| I5 | `src/lib/hotkeys.ts:236-272` vs `src/hooks/useGlobalShortcuts.ts:14` | `matchesEvent` handles `Ctrl` as `Ctrl||Meta` alias, but `formatEvent` pushes `Ctrl` for both `e.ctrlKey||e.metaKey` while `matchesEvent` later checks `wantMeta !== e.metaKey` with special fallback — contradictory Meta handling | `Ctrl+P` bound as `"Ctrl+P"` will also fire on `Meta+P` on mac-like keyboards, but `Meta` token bound explicitly won't compose | Document alias rule once; add tests for Ctrl/Meta equivalence | 🟠 Medium |
| I6 | `src/components/Composer.tsx:402-434` vs `src/components/MessageList.tsx:532-591` vs `src/lib/find.ts:21-59` | Find highlight exists in *three* places: `lib/find.ts:highlightFindInHtml` (HTML string), `Composer` overlay (HTML + `compMatches`), `MessageList` DOM TreeWalker mutation | Three implementations of same highlight with different active-class logic; Composer uses regex split, MessageList uses TreeWalker — bugs fixed in one won't reach others | Share single `useFindHighlight` hook or at least share `findMatches` consistently | 🟠 Medium |
| I7 | `src/components/DropdownPortal.tsx:9-22` vs `src/components/PickerMenu.tsx:1` | `PickerMenu` is a thin wrapper around `DropdownPortal` that adds trigger+outside-click; `ModelMenu`, `AgentMenu`, `VariantMenu`, `SecurityMenu`, `ThemeSelect` all *also* wrap `DropdownPortal` directly with near-identical outside-click handling | `PickerMenu` should be the shared primitive, but fancy pickers bypass it and reimplement | Make all pickers use `PickerMenu` or extract `useOutsideClose` hook | 🟡 Low |
| I8 | `src/styles/*.css` | Claimed spacing unit 6px, but `chat.css: gap 16px`, `composer.css: padding 12px 14px`, `sidebar.css: padding 6px 0` mixes 6/8/12/14/16; `layout.css: --perm-bottom` computed via JS not CSS calc | Design system contract violated — makes visual audit noisy | Document exceptions or enforce via `stylelint` 6px multiple rule | 🟡 Low |
| O1 | `src-tauri/src/lib.rs:1013-1221` | `wininput` (120 LOC) + `unpoison_input` (80 LOC) + `webfocus` (70 LOC) = ~270 LOC raw Win32 `extern "system"` bindings for cursor wiggle, `EnumChildWindows`, `WM_CANCELMODE`, subclassing `WM_ACTIVATE→MoveFocus` | Re-implements `windows` crate helpers and `webview2-com` already in `Cargo.toml`; `b64()` at `lib.rs:1411` hand-rolls base64 instead of `base64` crate; high unsafe surface for a workaround | Keep mitigation but replace custom FFI with `windows` crate APIs (`GetDC`, `SendInput` etc. already in crate) and `base64` crate; gate behind `#[cfg(windows)]` feature | 🔴 High |
| O2 | `src-tauri/src/lib.rs:1411-1424` | `fn b64(d:&[u8])->String` manual base64 | Standard lib exists; custom impl slower and untested for padding edge | `use base64::Engine::encode` or `data_encoding` | 🟡 Low |
| O3 | `src-tauri/src/lib.rs:313-320` + `351-351` | `plugins_dir()` `fn themes_dir()->PathBuf` builds path via `USERPROFILE/.config/.opencode-gui` with manual `PathBuf::join` | Duplicates `dirs` crate or `tauri::path`; ignores `APPDATA` on Windows | Use `app.path().app_config_dir()` like `workspace_file` does | 🟡 Low |
| O4 | `src/components/Composer.tsx:27-89` | `draftHtml(src)` 60-line manual parser with `consumedBlankAt` state for code-block slab, plus sentinel `\n` hack `needsSentinel` | Purpose is to keep highlight overlay glyph-aligned; CSS-based highlight (background on `<code>` not wrapper span) would avoid manual line swallowing | Replace with CSS `white-space: pre-wrap` + highlight only body, not blank-line ownership | 🟠 Medium |
| O5 | `src/components/Sidebar.tsx:136-227` + `src/hooks/useOpencode.ts:565-600` | Drag-drop preview `updatePreviewFromY` / `onDragOver` / `tauri://drag-drop` handler contain *three* copies of header position scanning `container.querySelectorAll("[data-ws-header]")` → `getBoundingClientRect` loop | Copy-pasta; any tweak to insertion math must be patched thrice | Extract `function dropIndexAt(y:number, extraLen:number):number` helper | 🟡 Low |
| O6 | `src/hooks/useProviders.ts:322-330` | `variantSel` memo comment "ponytail: single string per session, not per-model-per-session — if you pick 'high' for model A then switch to model B … split to `${sid}:${model}` if that bites" | Known design shortcut with user-visible bug: effort bleeds across models in same session | Fix now or document in README; current stale-value check `modelVariants.includes(v)` only masks, doesn't fix | 🟠 Medium |
| O7 | `src/pages/ChatPage.tsx:1-1258` | `ChatPage` 1258 LOC orchestrates updater, plugins, speech, voice routing, browser bar, terminal, file-editor presence, find routing, sidebar resize, and 200 LOC of `useEffect` for focus rescue that duplicates `src-tauri` `unpoison_input`/`webfocus` | Violates `AGENTS.md:79-88` rule "new visuals → components, new server talk → hooks"; composition should be declarative | Split `useVoice`/`useFindRouting`/`useFocusRescue` out of page; keep `ChatPage` as grid + providers only | 🟠 Medium |
| R1 | `src/assets/cur-col-resize.png` | Bundled fallback cursor PNG | Never referenced after `resize_cursor` Rust command ships real system cursor as data URL; `src/styles/layout.css` not referencing asset | Delete or keep as explicit fallback with comment; ensure `vite` doesn't bundle unused asset | 🟡 Low |
| R2 | `src/lib/recommended.ts:12-13` | `RECO_URL = "https://raw.githubusercontent.com/NoxLoveYa/-Vibecoded-Agent/..."` | Points to personal fork, not `anomalyco/opencode`; self-update `PLUGINS_API` etc. also use custom URLs — if fork deleted, onboarding defaults stay stale | Point to organization-owned URL or make configurable; add test that URL 200s | 🟢 Note |
| R3 | `src/styles/syntax.css` + `src/lib/termHighlight.ts` vs `src/styles/terminal.css` | Two highlight systems: `lowlight + hast-util-to-html` for chat/file-editor, custom ANSI parser for terminal | Not strictly duplicate, but reviewer expects one; undocumented split | Comment in `syntax.ts` header that terminal uses `termHighlight.ts` ANSI path | 🟡 Low |
| R4 | *(repo root)* `default_plugins/` | Discount-type example plugins left in repo | Ship to user as examples but not cleaned | Move to `examples/` or document that they are reference implementations | ⚪ Note |

---

## Category Deep Dives

### 1) Dead Code

**D1 `src/lib/clipboard.ts:54` `clipboardHasText`** — grep across `src/` shows only `clipboardWrite`/`clipboardRead` callers (`SelectionMenu.tsx:47`, `Sidebar.tsx`) . `clipboardHasText` (which itself calls `clipboardRead` → `tauriRead` → `navigator.clipboard.readText`) is fully orphaned. It also double-reads clipboard (read then check length) — wasteful even if used. Suggested fix: delete export; if future paste guard needed, implement via `navigator.clipboard.readText().then(t=>t.length>0)` inline.

**D2 `src/hooks/useOpencode.ts:301` `void rememberAgentSession;`** — this is not the legitimate `void promise` pattern (which suppresses floating promise warning). `rememberAgentSession` is a `useCallback` value, not a promise. Line forces evaluation then discards — effectively `undefined;`. Likely added to satisfy `no-unused-vars` after refactoring `rememberAgentSession` out of an effect dep array. Delete; add `// eslint-disable-next-line` if lint requires.

**D3 `src/lib/drafts.ts:27-29` `clearDraft`** — wrapper adds no behavior. Callers split: `useOpencode.ts:873`, `1481`, `1646` use `clearDraft`; `revertTo` path uses `setDraft(id, pasted)` . Having both names invites inconsistency (some call sites use `setDraft(id,"")` directly). Pick one name.

**D4 `src/lib/editorKeys.ts:461-493`** — self-check guarded by `(globalThis as any).process?.argv[1]?.endsWith("editorKeys.ts")`. In Tauri WebView2 bundle `process` is undefined, so branch never runs, but the 32 lines still ship and `console.log("editorKeys self-check passed")` appears in prod if run via `npx tsx`. Proper place is `src/lib/editorKeys.test.ts` (already empty of editorKeys tests? only hotkeys etc. exist).

**D5 `src/main.tsx:63-73` + `src-tauri/src/lib.rs:1395-1403`** — `debug_log` is marked `// TEMP diagnostics … remove once the crash is fixed` yet the `muse-spark-1.2` model docs suggest crash still under investigation. File `%TEMP%\oc-gui-debug.log` grows unbounded (append-only) and `console.error` wrapper also invokes `invoke("debug_log")` — if Rust side logs via `eprintln!` that triggers `console.error` again via JS error listener, loop possible (mitigated by `catch(()=>{})` but still noisy).

### 2) Contradictory Logic

**C1 `src/api.ts:63-91`** — Detailed trace:
```ts
cached = attempt().catch(e => retryAfter400ms).catch(e=>{cached=null; throw})
cached.catch(()=>cached=null) // third clear
```
If `attempt()` rejects and retry also rejects, `cached` becomes a *rejected* promise that was already cleared to `null` inside inner catch but *then* outer catch runs and clears again. Two concurrent callers doing `opencode()` between first reject and retry resolution get the same *pending* retry promise vs `null` vs new `attempt()` depending on timing — race window 400ms. Fix: don't cache rejected promises at all; cache only `{base,client}` after success, or use `let inflight: Promise<...> | null`.

**C3 `src/hooks/useOpencode.ts:1` `@ts-nocheck`** — The largest hook bypasses type checking while `package.json:8` runs `tsc && vite build`. A type error in this file will never block `run.ps1 check` or CI. Combined with ~40 `as any` casts inside, the `Session`/`Message` SDK drift (noted as "SDK types stale" in `useProviders.ts:203`) cannot be caught.

**C6 Boot SSE** — `getAllDirs()` recomputed every 2s via `setInterval`; if user removes a workspace while SSE `open` event still pending, `esMap.delete(d)` closes the EventSource but `liveCount` not decremented — `live` stays `true` forever. Similarly, `liveCount` is closed-over primitive, not `useRef`, so `es.onerror` not updating it is intentionally ignored comment but leaves stale true after network loss.

**C9/C10 SessionStore** — `orphanParts: Map<string,{sid,parts}>` keyed by `messageID` assumes message IDs globally unique — safe on server but confusing because `part.messageID` may collide across sessions if server reuses IDs? Deleting `pendingDeltas` in `applyMessage` before flushing orphan parts prevents duplication, but the counterpart in `applyPart` success path deletes orphan entry *after* upsert — leaving a window where a concurrent `applyDelta` for same part lands in `pendingDeltas` and later doubled when `flushDeltas` runs from unrelated `applyMessage`.

### 3) Confusing Naming

**N1** — The four "per-session memory" blocks use subtly different key names: `oc.sessionAgents` vs `oc.sessionModels` vs `oc.sessionVariants` vs `oc.sessionSecurityMode` vs `oc.lastModel`/`oc.lastAgent`/`oc.variants`/`oc.securityMode`. `variantMap` vs `sessionVariants` vs `sessionModels` — reader must map "variant = thinking effort" mentally each time. Suggest consistent prefix: `oc.perSession.{model,agent,variant,security}[sid]`.

**N2** — `active: Map<string,{url,style}>` aliasing: after `loadOne`, same `{url,style}` stored under both `dir` and `id`. `unloadPluginResources(idOrDir)` must handle both alias shapes plus fallback `document.querySelector('style[data-plugin]')` — three removal paths for one resource.

**N3** — `refreshSessionsFor(dir)` (single dir) vs `refreshSessions()` (all dirs) vs `getAllDirs()` — plural vs singular expectations inverted; `getAllWorkspaces()` vs `getWorkspaces()` vs `getExtraWorkspaces()` — three functions returning overlapping slices of same array.

### 4) Inconsistent Patterns

**I1 Workspace Sources** — truth table:
| Source | Read In | Written By |
|--------|---------|------------|
| `directory` var (`api.ts`) | `getDirectory()` (sync) | `setDirectory()` from `workspace.ts:applyWorkspace` and `main.tsx:hydrateWorkspace` |
| `localStorage oc.settings.workspace` | `workspace.ts`, `useSettings`, `useOpencode:getAllDirs` | `workspace.ts:applyWorkspace`, `useSettings:update` |
| Rust file `app_config_dir/workspace` | `workspace_get` | `workspace_set` invoked from both previous rows |
Any two can diverge between paint and Tauri invoke (`setTimeout reload 50ms` in `applyWorkspace:106` masks but doesn't eliminate). New code sometimes calls `getDirectory()` (module var) sometimes reads `localStorage` directly — no canonical accessor.

**I2 Colors** — `useSettings.ts:45-81` `DEFAULT_COLOR_SETS` duplicates `themes.ts:31-60 FALLBACK` + `BUILTIN_LIST` per-theme `vars`. They intentionally differ (settings holds appearance-editable subset: base/surface only, themes holds full palette), but comment doesn't state that — looks like copy-paste. Actual bug: `useSettings:applyTheme` path uses `hexToRgb(cs.base)` for `--base-rgb`, while `themes.ts:applyTheme` sets `--base-rgb` via palette's own `vars["--base-rgb"]` string — two code paths set same CSS var to potentially different values depending on edit state.

**I5 Hotkeys** — `matchesEvent` `Ctrl` alias handling is intentionally cross-platform (`Ctrl` in storage means Ctrl *or* Meta), but docs in `hotkeys.ts:173` vs `AGENTS.md` don't mention it. Plugin hotkeys via `usePluginHotkeys` bypass alias? Worth clarifying in `HOTKEY_META`.

### 5) Overengineering

**O1 input poisoning** — The comment chain explains the workaround history (`tauri#15624`, `wry#1755`, "fixed upstream not yet released") but the fix ships *two* parallel mechanisms: (a) `unpoison_input` posted `WM_MOUSEMOVE` + `SendInput` wiggle + `SetFocus` on `Chrome_WidgetWin*` class scan, and (b) `webfocus` subclass `WM_ACTIVATE → PostMessage(MSG_REFOCUS) → MoveFocus(PROGRAMMATIC)`. Either alone may suffice post-2.11.5; hedging doubles unsafe surface and the `Explorer` path's `EnumChildWindows` recursion (`focus_webview_child` calls itself via `EnumChildWindows` — recursion depth = webview tree depth, safe but unusual).

**O4 `draftHtml`** — Goal: "trailing empty line renders" and "blank line above/below fence joins slab so background continuous". Achieved via 60 lines of blank swallowing and sentinel `\n` appended when `base.includes("comp-codeblock") && input.endsWith("\n")`. A simpler approach: put `display:block` background on `comp-fence` only, let normal block margins handle gaps; sentinel not needed.

**O7 `ChatPage`** — File reimplements focus rescue already in Rust (`webfocus` + `unpoison_input`) *and* subscribes to same Rust events (`focus://restore`, `visibility://changed`) to do JS-level `document.activeElement` restore. Three layers of focus rescue: Rust `wininput::focus_webview`, Rust `webfocus::proc`, JS `useGlobalShortcuts` `rescueFocus` — which can fight (JS `SetFocus` racing `MoveFocus`).

### 6) Orphaned / Untracked

**R2** — `recommended.ts:13` hardcodes `NoxLoveYa/-Vibecoded-Agent`. If audit repo is `anomalyco/opencode` fork, this leaks personal account into production update path. At minimum, make env-configurable.

---

## Recommendations (prioritized)

1. **Remove `@ts-nocheck`** (`C3`) and fix `any` casts with narrowed `unknown` checks — re-enables CI guard.
2. **Collapse `opencode()` retry** (`C1`) and unify workspace source (`I1`) — two biggest correctness risks.
3. **Extract per-session override factory** (`N1`) and shared `storageKeys.ts` — eliminates ~200 LOC duplication and inconsistent migration (`sessionStorage` legacy only handled for models).
4. **Replace custom FFI** (`O1`, `O2`) with `windows` crate helpers + `base64` crate after verifying upstream fix shipped in used Tauri version; delete `b64`.
5. **Delete dead exports** (`D1-D5`) and move `editorKeys` self-test to test file.
6. **Unify find highlighting** (`I6`) and drag-drop insertion math (`O5`) into single helpers.
7. **Split `ChatPage`** (`O7`) — extract `useVoiceOrchestrator`, `useFindRouting`, `useWorkspaceSSE` so page stays <300 LOC per AGENTS rule.

---

## Appendix: Full File Inventory Checked

```
src/api.ts                 ✅ Proxy, retry, hiddenSessions
src/hooks/useOpencode.ts   ✅ 1778 lines traced
src/hooks/useProviders.ts  ✅ per-session model/variant mirroring
src/hooks/useSettings.ts   ✅ theme/config hydration
src/hooks/usePlugins.ts    ✅ incremental reload alias map
src/hooks/useGlobalShortcuts.ts ✅ focus rescue vs Rust duplicate
src/lib/sessionStore.ts    ✅ orphanParts/pendingDeltas ordering
src/lib/busyTracker.ts     ✅ inflight/settle/queue triple state
src/lib/workspace.ts       ✅ vs api.directory divergence
src/lib/themes.ts          ✅ FALLBACK vs BUILTIN_LIST duplicate
src/lib/plugins.ts         ✅ active alias map
src/lib/sounds.ts          ✅ prefs gate
src/lib/syntax.ts          ✅ MAX caps heuristic
src/lib/hotkeys.ts         ✅ Ctrl/Meta alias
src/lib/find.ts/.ts, editorKeys.ts, clipboard.ts, drafts.ts, recentModels.ts,
         attachments.ts, commitPrompt/Heuristic, version, speechText, uiScale, etc. ✅
src/components/Composer.tsx, MessageList.tsx, Sidebar.tsx, FileTree, ToolBlock, DropdownPortal, etc. ✅
src/pages/ChatPage.tsx     ✅ 1258 lines wiring
src-tauri/src/lib.rs       ✅ 2048 lines (wininput/webfocus/job/b64/jumplist)
src/styles/*.css (22 files) ✅ header scan for unit/spacing, unused tokens
src/assets/cur-col-resize.png ✅ orphaned fallback check
```

*No `TODO`/`FIXME`/`HACK` comments found besides `ponytail:` debt markers listed in N5. No commented-out code blocks detected. No orphaned `*.test.ts` without runner — tests are run via `npx tsx` self-check pattern, missing `package.json` `test` script.*

---

*Generated by read-only audit — all line numbers verified against files on disk at audit time.*
