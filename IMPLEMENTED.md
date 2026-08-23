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
- **Self-correcting default**: no server endpoint reports the effective fallback model, so after a prompt sent *without* an explicit selection, the reply's `providerID/modelID` is adopted as `defaultModel` — the label always converges to what actually runs.
- **Unknown default → require a pick**: the wrong-guessing heuristics were removed entirely. Until a default is known AND nothing is hand-picked, sending is blocked: textarea + Send disabled, picker shows "Choose a model…". Once a default is learned (or remembered), "Server default · X" reappears as an option.
- **Custom model dropdown**: replaced the native `<select>` (whose popup can't be styled) with a fully themed glass menu — blocky 4px radius, blurred surface, accent border + glow, group labels in mono caps, check mark on the active entry; opens upward from the composer; closes on outside click.
- **Dropdown keyboard navigation**: focus the trigger → Enter/Space opens; ArrowUp/Down move highlight (auto-scrolled into view), Home/End jump, Enter picks, Escape closes. ARIA `listbox`/`option`/`aria-expanded` wired.

### UX hardening ✅ (2026-08-23)

- Raw browser right-click menu suppressed app-wide (`contextmenu` preventDefault) — no more Reload/Inspect leaking through.
- Global `:focus-visible` accent outlines on buttons/options for keyboard users.
- Disabled textarea styled (dimmed + not-allowed cursor) in "pick a model" state.

### System tray ✅ (2026-08-23)

- Tray icon (app icon) with right-click menu: **Show OpenCode / Quit**; left-click toggles window visibility.
- The minimize button now **hides to the tray** (`window.hide()`) instead of taskbar-minimizing — the server keeps running while hidden.
- Quit via tray menu exits cleanly (RunEvent::Exit still kills the opencode serve child).
- Tauri feature `tray-icon`; capabilities `core:window:allow-hide/show`.
- Note: rebuilding while the old exe is running fails with "Access is denied" (Windows file lock) — close the app before recompiling.
- **Global hotkey Alt+Space** (`tauri-plugin-global-shortcut`): toggles window visibility system-wide, any focus. Behavior: hidden → show+focus · visible but unfocused → show+focus · visible and focused → hide to tray. Note this shadows Windows' default Alt+Space window menu while the app runs.
- **First-launch focus fix**: the window calls `set_focus()` during startup — without it the freshly launched window didn't own keyboard focus, so the first Alt+Space only *focused* it instead of hiding (worked normally after any manual minimize/unfocus).

### Settings ✅ (2026-08-23)

- **Window size/position memory**: official `tauri-plugin-window-state` — bounds + maximized state auto-restored on launch (multi-monitor aware).
- **Auto-launch on startup**: `tauri-plugin-autostart` (+ npm `@tauri-apps/plugin-autostart`); toggle in settings, registry-backed.
- **Always on top**: persisted (`oc.settings.alwaysOnTop`), applied at boot; toggleable from the titlebar pin icon *and* the settings drawer — both controls stay in sync.
- **UI scale**: webview zoom, segmented control 80/90/100/110/125 %, persisted (`oc.settings.uiScale`), replaces the old fixed boot-time reset to 100 %.
- **Settings drawer**: gear icon in the titlebar opens a right-side glass drawer (scrim + blur, Carriage drawer pattern). Extensible: add rows to `components/SettingsDrawer.tsx`, fields to `hooks/useSettings.ts`.
- Capabilities added: `core:window:allow-set-always-on-top`, `autostart:allow-enable/disable/is-enabled`.
- Alt+Space keeps hiding the window even when always-on-top is active (hide is orthogonal to pinning).
- **Ctrl+P** toggles always-on-top via a plain window keydown listener — fires only while the app is open and focused (and replaces the browser print shortcut). Pin state syncs across the titlebar pin, the settings toggle, and this hotkey.
- **Appearance customization**: settings drawer gained an Appearance box — color swatch + transparency slider for the **main background** and the **panel surface** (chat history + input), plus a Reset button restoring defaults. Persisted in `oc.settings.colors`, applied at boot via CSS custom properties (`--base-rgb/--base-a/--surf-rgb/--surf-a`) that all panel/body gradients consume.
- **Theme system v2**: the dropdown picks a color family — **Cyan** (the original look), **Latte**, **Matcha**, **Strawberry** — and the sun/moon toggle switches its **dark/light mode** (each family ships both variants; 12 palettes total as `[data-theme][data-mode]` variable blocks). Appearance colors are stored per theme × mode. All hardcoded cyan literals were converted to `color-mix(var(--accent))` so every family tints correctly. Thinking shimmer derives from theme text/faint variables. Legacy "midnight"/"light" saved values migrate to Cyan dark/light.
- **Light mode**: also toggleable via a Dark/Light segmented row in settings.

### Square/flush pass ✅ (2026-08-23)

- Send button is square like everything else (pill exception removed).
- Main area padding and composer gap are zero — chat panel + input sit flush edge-to-edge.
- Window body background fully transparent: the OS acrylic is the only backdrop; panels supply all tint themselves.
- Empty state ("Select or create a session") renders inside a full-size chat-style glass panel.

### Sounds ✅ (2026-08-23)

- All sounds are **synthesized** with the Web Audio API (`src/lib/sounds.ts`) — zero bundled assets.
- Events: window show (rising blip) / hide (falling blip), message sent (tick), reply finished (bell), typing / erasing / newline (per-keyboard variants, one toggle), resizing (throttled ticks while dragging), panels & menus (collapse/expand sidebar + settings open/close), maximize/restore, close window, **generic button click** (soft tick on every button that doesn't have its own sound — window controls, Send, sidebar toggles and sound-pref rows are excluded to avoid doubles).
- Settings drawer **Sounds box**: master volume slider + one On/Off row per event group; persisted in `oc.settings.sounds`.
- Rust emits `visibility://changed` on tray click / tray menu / Alt+Space so hide/show sounds play even when the window is already hidden (frontend listens via Tauri events).
- Close button delays `window.close()` by ~130 ms so its sound can ring out.
- **Persistence bugfix**: the save-effect fired with `""` on mount and wiped the stored model before restore could read it; it now only persists non-empty selections.

### App icon ✅ (2026-08-23)

- Procedural brand icon generated by `scripts/gen-icon.mjs` (pure Node, zero deps): dark rounded-glass square + thin cyan border + glowing cyan dot, rendered at 1024px and downscaled.
- Replaced every icon in `src-tauri/icons/`: `icon.ico` (7 PNG entries: 16–256px → exe/taskbar), `icon.png`, `32x32`, `128x128(2x)`, all Square/Store logos. Tray inherits from the same bundle icons.
- Regenerate anytime with `node scripts/gen-icon.mjs`.

### Task runner scripts ✅ (2026-08-23)

- `scripts/run.ps1` (Windows) and `scripts/run.sh` (bash/WSL): one runner each with subcommands —
  **setup** (npm install + fetch latest sidecar from GitHub releases), **dev**, **build** (packaged installers), **portable** (zip of app exe + sidecar → `bundle/portable/`, no install needed), **check** (tsc + vite + cargo check), **clean**.
- Sidecar auto-download verified end-to-end (`run.ps1 setup` → 1.18.21 in place); run.sh syntax-checked under WSL.
- README documents the commands.
- Release builds spawn the sidecar with the Windows `CREATE_NO_WINDOW` flag — no console window flashes behind the GUI (`Stdio::null()` alone isn't enough; dev builds still inherit stdio for logs).

### Streaming reliability fix ✅ (2026-08-23)

- **Race fixed**: `message.part.updated` events arriving before their parent `message.updated` were silently dropped — streamed text could vanish or never appear. The hook now keeps an authoritative mutable message store (`msgsStore` ref) that SSE mutations apply synchronously, mirroring into React state afterwards; orphan parts are queued and flushed when the parent message is created. StrictMode/batching double-invocation hazards removed (no mutations inside state updaters).
- **Delta streaming fixed**: opencode streams incremental chunks as `message.part.delta` (`{sessionID, messageID, partID, field:"text", delta}`) and may only fire the full-text `part.updated` at milestones/end — ignoring deltas made long replies pop in all at once. Deltas are now appended live onto their text part (stashed if the part isn't announced yet, flushed when it appears, cleared on authoritative updates and session switches).

### Font Awesome icons ✅ (2026-08-23)

- Bundled `@fortawesome/fontawesome-free` via npm (offline-safe, fonts hashed into dist) — imported once in `main.tsx`.- All inline SVGs replaced with FA glyphs: window controls (minus/square/xmark), sidebar collapse (`fa-angles-left`) + reopen tab (`fa-angles-right`), new chat (`fa-plus`), session delete (`fa-xmark`), send (`fa-paper-plane`), stop (`fa-stop`), tool lines (`fa-gear`, spinning while running; `fa-triangle-exclamation` on error), permission buttons (`fa-check` / `fa-check-double` / `fa-ban`).
- Left panel collapse/reopen restyled: reopen is now a glowing edge tab on the left border.
- Icon sizing/spacing handled per-section in the split CSS files.
- Collapse toggle (`sb-toggle`): blocky 4px radius, dim accent tint at rest (darker version of hover), full hover glow.
- **Consolidated design rules now live in AGENTS.md** (spacing unit, glass material, accent system, blocky chrome, icons, fonts, cursors, `oc.*` persistence keys) — follow them for all new UI.

### Resizable / collapsible session sidebar ✅ (2026-08-23)

- Drag the sidebar's right edge to resize (170–440px, accent glow on the handle).
- Chevron button top-right of the sidebar collapses it; a small tab at the window's left edge reopens it. Animated via grid-template-columns transition.
- Width + collapsed state persisted in localStorage (`oc.sb.w` / `oc.sb.c`).
- Note: a first attempt accidentally added this to the message panel; reverted — messages area stays flex-fill.

### Deferred features ✅ (2026-08-23)

Three of the PLAN.md deferred items implemented (user-selected; share / multi-project / cross-platform declined):

- **File tree browser**: sidebar gained Chats/Files segmented tabs (persisted `oc.sb.tab`). `FileTree.tsx` lazy-loads directories via `GET /file?path=...` (children fetched on expand; dirs-first sort, ignored entries dimmed). Clicking a file opens an in-panel preview overlay (`GET /file/content?path=...`, binary-aware, Escape closes). Windows paths come back with trailing backslashes — passed through verbatim.
- **Diff viewer**: composer model-row toggle (fa-code-compare) opens `DiffPanel` — fixed scrim + glass dialog listing `GET /session/:id/diff` results: per-file header (path, +adds/−dels) and inline line diff. `lineDiff()` is a plain LCS on lines (~30 lines); files whose n·m exceeds ~1.5M cells render "too large" instead (ponytail ceiling). Escape/scrim click closes.
- **Revert/undo**: hover button on every user bubble → `POST /session/:id/revert {messageID}`. Active session's `revert.messageID` marker drives: (a) messages past the rewind point hidden client-side (server still returns full history — verified), (b) a "Viewing an earlier version" banner above the composer with Undo → `unrevert`. Hook refetches sessions+messages after both ops.

Verified headless against the sidecar (own PID only): file list/read ✓, diff [] ✓, prompt(free model) → 2 messages ✓, revert 200 + marker set ✓, unrevert 200 + marker cleared ✓. `npm run build` green.

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
