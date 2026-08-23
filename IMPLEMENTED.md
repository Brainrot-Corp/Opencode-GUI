# Implementation Tracker

Companion to [PLAN.md](./PLAN.md). Updated continuously: what's done, what's next.

Status legend: `[x]` done · `[~]` in progress/partial · `[ ]` not started · `[!]` blocked/issue

## Phase 1 — Scaffold ✅ (2026-08-23)

- [x] Verify toolchain (Node v24.19.0, npm 11.17.0, Rust 1.98.0 via rustup, MSVC Build Tools VS 18 preinstalled)
- [x] Scaffold Tauri v2 + React + TypeScript app (`create-tauri-app`, react-ts template)
- [x] Strip template boilerplate (removed opener plugin from JS/Rust/capabilities, demo greet command, logos/CSS, renamed to `opencode-gui`)
- [x] Install `@opencode-ai/sdk` (v1.18.21)
- [x] Download official `opencode.exe` release binary (v1.18.21 → `src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe`)
- [x] Configure sidecar in `tauri.conf.json` (`bundle.externalBin: ["binaries/opencode"]`)
- [x] Build passes — `npm run tauri build` produces MSI + NSIS installers

### Phase 1 measurements

| Artifact | Size |
|---|---|
| App exe (`opencode-gui.exe`) | **8.3 MB** |
| Bundled sidecar (`opencode.exe`) | 171 MB uncompressed |
| NSIS installer | 42.5 MB |
| MSI installer | 60.1 MB |

Installer size is dominated by the opencode binary itself, not our app. Option if size ever matters: stop bundling and auto-detect a user-installed `opencode` on PATH first → installer drops under ~10 MB. Not needed now.

### Phase 1 findings

- ✅ `opencode serve` runs natively on Windows without WSL — smoke test passed: `/global/health` returned `{healthy:true}` in <1s. WSL fallback not needed.
- Sidecar naming requires target-triple suffix: `opencode-x86_64-pc-windows-msvc.exe`.
- npm has an allow-scripts policy here; esbuild's postinstall had to be approved once (`npm approve-scripts esbuild`).

## Phase 2 — Server lifecycle ✅ (2026-08-23)

- [x] Spawn `opencode serve --port <free-port>` on launch (Rust `std::process::Command`, ephemeral port via `TcpListener` bind to :0; sidecar resolved next to current exe)
- [x] Poll `/global/health` until ready — done **in the webview** via browser fetch (same path Phase 3 uses, so CORS is proven end-to-end)
- [x] Kill child process on window close/app exit (`RunEvent::Exit` → `Child::kill`)
- [x] Pass base URL into webview (`server_url` Tauri command returning `Result<String,String>`)

### Phase 2 findings

- ✅ Lifecycle verified against release build: spawn → healthy on random port → graceful window close → serve pid dead → port dead.
- opencode keeps an internal helper process that holds the listening socket for a few seconds after the direct serve child dies, then self-terminates. No extra cleanup needed on our side.
- ⚠️ Skipped Windows Job Objects (kill-on-close): empirically unnecessary since both our kill handler AND opencode's self-cleanup work. Revisit only if orphaned servers are ever observed after a GUI crash.
- ⚠️ Lesson learned: never blanket-kill `opencode.exe`/`wsl.exe` processes when testing — the user's own agent session lives in those. Only touch exact PIDs spawned by our app.
- PowerShell 5.1 `Invoke-WebRequest` chokes on this endpoint (auth-prompt quirk in noninteractive mode); use `curl.exe` for API smoke tests.

## Phase 3 — Minimal chat client ⬜ next

- [ ] SDK client setup (`createOpencodeClient`) + React context
- [ ] Session sidebar (list / create sessions)
- [ ] Chat view: message list + text parts rendering
- [ ] Prompt input → `session.prompt_async()`
- [ ] SSE live updates (`message.updated`, `message.part.updated`)
- [ ] Markdown rendering for assistant output
- [ ] Model picker (`config.providers()`)
- [ ] Permission dialog → approve/deny endpoint
- [ ] Abort button while streaming

## Phase 3 — Minimal chat client ✅ code complete, GUI test pending (2026-08-23)

- [x] API helper (`src/api.ts`): `createOpencodeClient` from browser-safe `@opencode-ai/sdk/client` subpath + base URL via `server_url` command
- [x] Session sidebar: list / create / select / delete; newest first
- [x] Chat view: message bubbles, markdown rendering (`react-markdown` + `remark-gfm` — safe React rendering, no raw HTML injection), tool parts as compact status lines
- [x] Prompt input → `session.prompt_async()` (Enter to send, Shift+Enter newline)
- [x] SSE live updates: native `EventSource` on `/event`; handles `message.updated`, `message.part.updated`, `permission.updated`, `session.idle`, `session.deleted`; auto-reconnect built in
- [x] Model picker: grouped `<select>` from `config.providers()`; empty = server default
- [x] Permission dialog: Allow once / Always allow / Deny → `postSessionIdPermissionsPermissionId`
- [x] Abort button while streaming (+ busy flag cleared on assistant `time.completed` and `session.idle`)
- [x] Build passes

### Phase 3 verification (headless, real provider)

Full end-to-end flow exercised against a live DeepSeek model with curl + SSE capture:
- `prompt_async` → 204 ✓
- Streamed events observed: `message.updated` ×6, `message.part.updated` ×5, `message.part.delta`, `session.status`, `session.idle` ✓
- Text parts arrive **fully accumulated** per update (replace-by-part-id is the right strategy) ✓
- Assistant completion signaled by `time.completed != null` in `message.updated` ✓
- User messages are echoed via `message.updated` (no optimistic local add needed) ✓

### Phase 3 notes

- SDK main entry is Node-only (spawns servers); must import from `@opencode-ai/sdk/client`.
- PowerShell 5.1 body-quoting pitfalls when testing JSON APIs: single quotes don't survive native arg parsing, `-Encoding UTF8` adds a BOM. Use `[IO.File]::WriteAllText` + `curl --data-binary @file`.
- ✅ Permission round trip fully verified headless (2026-08-23): with a `"permission":{"bash":"ask",...}` config, the server emits **`permission.asked`** (NOT `permission.updated` — SDK types are stale), properties `{id, sessionID, permission, metadata, patterns, always}`. UI handler normalized accordingly; handles both event names.
  - Approve flow: `POST /session/:id/permissions/:id {"response":"once"}` → 200 → tool completes → run finishes.
  - Note: with NO permission config (user's current setup), bash defaults to allow — tools run silently, which is why no dialog appeared in the first GUI test. To see prompts, add a permission block to `~/.config/opencode/opencode.jsonc`.

## Phase 4 — Package & verify ✅ (2026-08-23)

- [x] Final release build → MSI 60.1 MB / NSIS **42.6 MB** installer
- [x] App exe: 8.3 MB; cold start to healthy server: **~1.5 s**
- [x] Smoke test with **free model only** per AGENTS.md rule: `opencode/x-preview-f-free` replied "pong" via prompt_async+SSE ✓

## Project status: MVP COMPLETE ✅

All four phases done. Deferred features live in PLAN.md.

## Deferred (from PLAN.md)

File tree, diff viewer, revert/undo, share, themes, multi-project, cross-platform builds.
**Deferred even further per user (2026-08-23): design work comes first.**

## Design pass 1 — "Carriage" aesthetic ✅ (2026-08-23)

Applied the user's reference design (`design examples/index.html`) onto the existing opencode layout:

- Design tokens ported verbatim: deep blue-black bg (#090d11/#0d1218), cyan accent #7fd4d4 + glow vars, glass surfaces with backdrop blur, Inter + JetBrains Mono
- Ambient radial gradient background + animated film-grain noise overlay
- Chat area & composer: rounded-18px glass "stage" panels with accent glow on focus-within
- Sidebar: glass panel, glowing brand dot, dashed-accent new-chat button, session rows styled like the reference's doc-rows (hover tint, active accent border, delete revealed on hover)
- Message bubbles: mono font; user = accent-tinted, assistant = surface glass; full markdown styling (code blocks, tables, blockquotes)
- Thinking indicator: blinking glowing cursor block (reference's cta-cursor)
- Permission bar: floating glass card, pill buttons (accent allow / soft-red deny)
- Send/Stop as pill buttons with hover glow

Changed files: `index.html` (fonts), `src/styles.css` (full rewrite), `src/App.tsx` (noise overlay + markup tweaks only).

### Frameless window ✅ (2026-08-23)

- `decorations: false` in `tauri.conf.json`; custom glass titlebar (`Titlebar.tsx`) with drag region + min/max/close icon buttons (close hovers soft-red).
- Required capabilities: `core:window:allow-minimize`, `-toggle-maximize`, `-close`, and **`-start-dragging`** (the missing one is why dragging initially failed).

## Frontend restructure ✅ (2026-08-23)

Split single-file App.tsx (~400 lines) into a maintainable structure (see tree in PLAN.md):

```
src/
├── hooks/useOpencode.ts   — all state + server interaction (boot, SSE, sessions, send/abort, permissions)
├── components/            — Titlebar, Sidebar, MessageList, Composer, PermissionBar (presentational)
├── pages/ChatPage.tsx     — composition root for the main screen
├── types.ts               — shared local types
├── api.ts                 — unchanged client singleton
└── App.tsx                — thin shell rendering ChatPage
```

- Zero behavior change; `npm run build` green.
- Convention going forward: server talk → hooks, visuals → components, screens → pages. New screens go in `pages/` and get wired to their own hook.

### CSS restructure ✅ (2026-08-23)

`styles.css` split into `src/styles/` mirroring the component tree:

| File | Contents | Imported by |
|---|---|---|
| `tokens.css` | design vars, element base, scrollbars, film grain, reduced-motion | `main.tsx` |
| `layout.css` | app shell, titlebar, grid, main column, banner, empty state | `main.tsx` |
| `sidebar.css` | session list styles | `Sidebar.tsx` |
| `chat.css` | message stage, bubbles, markdown, tool lines, thinking cursor | `MessageList.tsx` |
| `composer.css` | input card, model picker, send/stop | `Composer.tsx` |
| `permission.css` | approval floating card | `PermissionBar.tsx` |

Each component imports its own stylesheet; global tokens/layout load once in `main.tsx`. Identical output CSS.

### Bugfix: layout "zoom" when history loads ✅ (2026-08-23)

Symptom: as soon as session data arrived, the whole UI appeared super-zoomed / cut off.

Root causes fixed:
1. `MessageList` used `scrollIntoView()` on new messages — it scrolls **all** scrollable ancestors including the page root, shoving the layout off-screen. Replaced with manual `container.scrollTop = scrollHeight` (strictly scoped to the message panel).
2. WebView2 page zoom (Ctrl+wheel / Ctrl±) silently persists across restarts. Now: reset to 100% at boot (`setZoom(1)`), zoom hotkeys blocked entirely via wheel/keydown preventDefault, capability `core:webview:allow-set-webview-zoom` added.
3. Hard guards: `body { position:fixed; inset:0; overscroll-behavior:none }`, sidebar width sanity-clamped from localStorage (170–440px).
4. **Final piece (confirmed by user):** the `.layout` grid had no row definition — its implicit row sized itself to chat content and pushed both columns past the viewport. Fixed with `grid-template-rows: minmax(0, 1fr)` + `overflow:hidden` on `.main`.

### Loading UI ✅ (2026-08-23)

Root cause of "nothing populates": server responses are sometimes slow; the UI showed empty states before data arrived (the temp diag line proved counts were just 0 *yet*).

- `useOpencode` now exposes `booting` — true until sessions + providers settle (success or fail).
- Sidebar: pulsing skeleton rows while booting.
- Messages: skeleton bubbles while booting.
- Model picker: disabled "Loading models…" until providers arrive.
- Premature "Say something…" / "Select or create…" prompts suppressed during boot.
- Temp diagnostics line removed (banner still shows real failures).
- Session list sorted by `time.updated` descending (most recent first); last-opened session id persisted (`oc.lastSes`) and restored on launch when it still exists, otherwise the newest opens.
- Model picker shows the **resolved** server default (e.g. "OpenCode · x-preview-f-free (server default)") instead of generic text; the last hand-picked model is persisted (`oc.lastModel`), validated against the provider list on launch, and re-selected if still available.
- Default resolution order (matches actual server behavior): `config.model` from opencode.jsonc → the opencode provider's entry in the default map → any provider's default. The naive "first provider in map" heuristic was wrong — it claimed DeepSeek while the server really streamed `opencode/x-preview-f-free`.

### Font Awesome icons ✅ (2026-08-23)

- Bundled `@fortawesome/fontawesome-free` via npm (offline-safe, fonts hashed into dist) — imported once in `main.tsx`.
- All inline SVGs replaced with FA glyphs: window controls (minus/square/xmark), sidebar collapse (`fa-angles-left`) + reopen tab (`fa-angles-right`), new chat (`fa-plus`), session delete (`fa-xmark`), send (`fa-paper-plane`), stop (`fa-stop`), tool lines (`fa-gear`, spinning while running; `fa-triangle-exclamation` on error), permission buttons (`fa-check` / `fa-check-double` / `fa-ban`).
- Left panel collapse/reopen restyled: reopen is now a glowing edge tab on the left border.
- Icon sizing/spacing handled per-section in the split CSS files.

### Resizable / collapsible session sidebar ✅ (2026-08-23)

- Drag the sidebar's right edge to resize (170–440px, accent glow on the handle).
- Chevron button top-right of the sidebar collapses it; a small tab at the window's left edge reopens it. Animated via grid-template-columns transition.
- Width + collapsed state persisted in localStorage (`oc.sb.w` / `oc.sb.c`).
- Note: a first attempt accidentally added this to the message panel; reverted — messages area stays flex-fill.

## Notes / Decisions log

- 2026-08-23: Project started. Plan finalized in PLAN.md (Windows only, Tauri v2, React+TS, fresh UI, minimal scope).
- 2026-08-23: Phase 1 complete. Sidecar approach verified end-to-end at build level; server spawn/kill wiring is Phase 2.
- 2026-08-23: Phase 2 complete. CORS needs no --cors flags (server reflects any Origin). Server lifecycle verified in release build.
- 2026-08-23: Incident note — during lifecycle testing, system-wide process kills nearly took down the user's own WSL opencode session (the agent running the session itself). Testing now strictly scoped to PIDs our app creates.
- 2026-08-23: Phase 3 code complete. End-to-end streaming verified headless with a live model (DeepSeek key already configured Windows-side). GUI smoke test pending.
- 2026-08-23: **Rule added (AGENTS.md)** — never test with the user's own API keys; use free models only (`opencode/x-preview-f-free` or OpenCode Zen free tier). Earlier DeepSeek test calls should not be repeated.
- 2026-08-23: Phase 4 complete. MVP done: Tauri app (8.3 MB exe / 42.6 MB installer) + opencode sidecar, cold start ~1.5 s, chat/streaming/permissions/abort verified. Free-model testing path confirmed working.
- 2026-08-23: Design pass 1 (Carriage aesthetic) + frameless custom titlebar done; deferred features pushed back further per user — design first.
- 2026-08-23: Frontend restructured into hooks/components/pages layout (see PLAN.md tree). No behavior change.
- 2026-08-23: CSS split into src/styles/ (tokens, layout, sidebar, chat, composer, permission) imported by their owners. See table in tracker above.
