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

### Workspace directory ✅ (2026-08-23)

Root cause found for "diff viewer shows nothing": `/session/:id/diff` returns **[] without a `messageID` query** — it serves each *user message*'s precomputed `summary.diffs` (see upstream `session/summary.ts`). Also, v1.18's real diff shape is `{file, patch, additions, deletions, status}` with a ready-made unified diff — SDK types (`before`/`after`) are stale; LCS renderer deleted in favor of coloring the server's patch. Snapshots (and therefore diffs + file-restoring revert) only work when the working directory is a Git repo — and the sidecar spawned in USERPROFILE.

Fix: per-request workspace switching via the server's `directory` query param (verified on v1.18: session lists, providers, file listing, prompts AND `/event?directory=` streaming all honor it — no sidecar respawn needed):

- `api.ts` wraps the SDK client in a Proxy merging `?directory=` into every call; `setDirectory()/getDirectory()`; SSE URL appends it too.
- Settings → **Workspace** row: native folder picker (`tauri-plugin-dialog`, capability `dialog:allow-open`), Reset-to-home button; changing reloads the webview (full reboot of sessions/messages/events).
- Persisted as `oc.settings.workspace`. Default remains home folder.
- Verified headless: prompt under `?directory=<git repo>` produces user-message `summary.diffs`; `/event?directory=` carries message/part/delta/session.diff events.

### Per-session streaming + activity indicators ✅ (2026-08-23)

Fixed "stream disappears when switching sessions mid-reply" and added per-session busy indicators:

- **Root cause**: every SSE handler early-returned unless the event's session was the active one — background streams were silently dropped, and `openSession` replaced the store with a fetch response (rapid switches could resolve out of order and cross-contaminate).
- **Fix (`useOpencode.ts`)**: message stores are now a `Map<sessionID, Msg[]>`. `message.updated` / `message.part.updated` / `message.part.delta` mutate the *event's* session store unconditionally; only the React-state mirror is gated on the active session. Deltas/orphan parts stash their sessionID. `openSession` shows the cached store immediately and refetches with a per-session sequence guard (stale responses discarded). `session.deleted` drops the store/busy state.
- **Per-session busy**: `busy` bool → `busyIds: Set<string>` (+ ref). Set on `send`, cleared on assistant `time.completed`, `session.idle`, abort, delete — for every session. Active-session `busy` is derived (`busyIds.has(activeId)`), so Composer/MessageList props are unchanged. Reply sound stays active-session-only.
- **Sidebar indicator**: pulsing glowing accent dot (`.row-busy`, reduced-motion aware) on each busy session row, independent of which session is open.
- Returning to a still-streaming session now shows its live partial output immediately (cached store + continued deltas).

### Tuya voice light control ✅ (2026-08-25)

Voice-only integration (user choice; no GUI panel, no MCP/agent path) using the **Tuya Cloud API**
(free tier) — signed HTTPS calls from Rust, DP-code mapping in TS:

- **`src-tauri/src/tuya.rs`** — HMAC-SHA256 request signing (token + general schemes from
  developer.tuya.com), ~24h access-token cache (`TuyaState`), region endpoints
  (us/eu/cn/in → `openapi.tuyaxx…`). Two commands: `tuya_lights` (GET `/v1.0/users/{uid}/devices`,
  filtered to light-ish categories / names) and `tuya_send` (POST `/v1.0/iot-03/devices/{id}/commands`).
  New deps: reqwest (rustls), hmac, sha2, hex. Creds passed per-call from the frontend.
- **`src/lib/tuya.ts`** — executor `runLightAct()`: resolves spoken name fragment against device
  names, auto-detects v1/v2 DP codes from each device's status list (`bright_value[_v2]`,
  `temp_value[_v2]`, `colour_data[_v2]`, `work_mode`), maps % → dp ranges, warmth words → temp scale,
  color words → packed HSV `hhhhssssvvvv`; 60s device-list cache; returns a spoken summary.
- **voiceRouter** — new acts `light/lightBright/lightTemp/lightColor` placed before the app-launcher
  catch-all: "lights on/off", "turn the desk lamp off", "dim the lights to fifty percent",
  "make the light warm/cool/daylight", "turn it red/blue…" (+ word numbers, % forms).
- **Settings › Lights** (`TuyaSettings.tsx`) — Access ID / Secret / account UID fields, region
  segmented control, "Find bulbs" test button; persisted in `oc.settings.tuya`.
- ChatPage dispatcher cases announce results/errors through the existing Piper TTS pipeline.

Verified: cargo check, `npm run build`, router 56 checks, tuya mappers 13 checks. **Live bulb test
passed (2026-08-25)**: real "Shelf" bulb (dj, v2 dp codes) pulsed off→on through the signed chain;
status read confirmed each hop. Real-world quirks handled: offline devices report no status array
(guarded), this firmware reports colour_data_v2 as a JSON string — encoder mirrors whatever shape
the device currently reports (hex fallback for older bulbs). Gotcha: the platform shows both a
device ID and the account UID (`eu…`-prefixed); only the UID works in `/users/{uid}/devices`.

### Mic no longer mutes during TTS — AEC + barge-in ✅ (2026-08-25)

User complaint: hands-free dropped everything said while a reply was playing. Replaced the hard
echo gate in `useVoice.ts` with:

- **Explicit AEC**: `getUserMedia({echoCancellation/noiseSuppression/autoGainControl: true})` —
  Chromium subtracts the page's own piper playback from the mic signal (root fix).
- **Barge-in**: while TTS is active, chunks are watched instead of discarded; ≥250 ms sustained
  above 2× VAD threshold fires `oc:tts-stop` (pauses reply + hushes its queue), kills the local
  grace window so capture resumes instantly, and seeds the live utterance from the pre-roll ring
  so word onsets survive. Quiet residue still discarded → no self-transcription loop.
- Tuning knobs flagged with a ponytail comment (barge threshold/duration); manual push-to-talk
  mode untouched.

`npm run build` green; all router/tuya checks pass. Live hands-free behavior needs a GUI test.

### Info dialog — tabbed guide from Settings ✅ (2026-08-25)

Settings header gained a circle-info button opening a glass `InfoDialog` layered above the drawer
(`Dialog` new `top` prop → z-70; the drawer sits at 65, dialogs default 30). Clickable tabs,
extensible via its data arrays:

- **Voice commands** — curated phrase list grouped like voiceRouter (Sessions & UI / Apps /
  Dictation & speech / Lights), rendered as mono cmd-rows
- **Commands** — the live slash registry grouped by source; grouping extracted from HelpDialog
  into shared `CommandRows`
- **Hotkeys** — cheatsheet: system-wide (Alt+Space, Ctrl+Shift+M), in-app (Ctrl+M/P, Tab agent
  cycle, Enter/Esc), composer autocomplete; notes for blocked zoom hotkeys

Wiring: ChatPage passes `oc.cmdList` into SettingsDrawer as a prop. `npm run build` green.

### Command-first voice ✅ (2026-08-25)

User request: mic listens for commands; unprefixed dictation must not populate the composer.

- Unrecognized speech → silently ignored (was: fill composer / autoSend).
- New capture prefixes in voiceRouter: **"prompt …"** → `{dictate}` fills the composer (appends
  to any staged draft), **"send …"** → `{dictateSend}` fills and submits at once. Bare
  "send / send it / envoyé" keep sending the staged draft (matchers ordered so short forms win).
- Composer: `send()` split into parameterized `sendWith(text)` + new `oc:voice-send-text` event —
  one event carries the full text because firing voice-text then voice-send back-to-back would
  read a stale draft closure.
- **Auto-send setting removed** (superseded by prefixes): toggle row gone from VoiceSettings,
  field dropped from AppSettings/loader; hands-free description updated.
- InfoDialog voice tab lists the two prefixes with the new ignore-note.

Router checks now 61; build green.

### Mid-sentence command scan + spoken confirmation ✅ (2026-08-25)

User scenario: chatting with friends, then "turn the lights off" — never picked up, because every
router pattern is full-string anchored and unprefixed speech is now discarded. Fix (user chose
in-transcript scanning over a wake word, with spoken confirmation for safety):

- **voiceRouter**: matcher chain extracted into `matchChain()`; `routeVoice` tries the whole
  transcript first (direct hits stay instant), then scans trigger verbs (`TRIGGERS` list) and
  re-runs the chain on each tail — first fully-matching suffix wins, returned as
  `{type:"embedded", act}`. Sentence-final rule intact: trailing clauses never fire; past tense
  ("turned") isn't a trigger.
- Light-intent name groups capped at 3 words so chatter can't be swallowed as a device name
  (this is what makes "stop the music **and turn the lights off**" resolve correctly instead of
  matching garbage on the first trigger).
- **ChatPage**: dispatch switch extracted to `execAct`; embedded acts are read back via
  `describeAct()` ("Turn the lights off — say yes or no.") and held in a pending ref: yes-words
  execute, no-words cancel, any other speech or 15s expiry cancels silently. Direct commands
  bypass confirmation. **Confirmation streak**: any executed command stamps `lastExecRef`;
  embeddeds within 25s of the last exec run instantly (no read-back), so an active voice session
  doesn't re-confirm every command.

Router checks 68; build green. Live GUI test pending. Pause-before-transcription slider removed
afterwards (user call) — VAD utterance close is the fixed SILENCE_MS (1.5s) again.

### Fast copy buttons ✅ (2026-08-25)

- **Fenced code blocks** (replies + thinking streams): hover copy button top-right of every
  ``` block — reads `textContent` at click time so syntax-highlight spans never corrupt the
  copied source; icon flips to a check for ~1.2s.
- **Tool blocks**: header copy button (next to the eye) copies the tool output, falling back to
  the input (e.g. the bash command) when there's no output. Shared `.copy-btn` style in chat.css.
  Copy targets the paste-ready payload: `read` output has its line-number gutter stripped (only
  when ~every line carries one), and the no-output fallback takes the primary string input value
  instead of a key:value dump.

`npm run build` green.

### Lexicon-driven voice commands (EN/FR/ES) ✅ (2026-08-25)

User ask: rethink commands for naturalness — "one trigger word becomes many". Implemented as a
rewrite layer, not per-language pattern packs:

- **`src/lib/voiceLexicon.ts`**: deaccent → politeness strip (can you/est-ce que/puedes…,
  please/merci/gracias…) → ordered rewrite table mapping EN+FR+ES variants onto canonical English
  vocabulary the router already matches ("allume la lumière"→"turn on the light", possessive swap
  "lampe du bureau"→"bureau lamp", colors/tones/devices/numbers/actions). JS `\b` ignores "é"
  (word-char is ASCII-only) — hence deaccent-before-match; documented.
- **Typo tolerance**: failed match retries with content words corrected 1 edit
  (substitution/insert/transposition — naive Hamming calls a swap 2). Verbs never fuzzed.
- **Bare device forms** added: "lights red" / "light warm" / "luz roja" direct-execute.
- Router: expand → matchChain → fixTypos retry → embedded scan on corrected text. hearCheck
  pattern widened (filler strip eats "can you"). Bare "envoye" (deaccented) added to send list.
- Confirmation yes/no answers trilingual (oui/sí/claro… non/anula/cancela…).
- Tests 78 (fr/es/typo/filler cases); build green. Design doc: `docs/voice-lexicon.md`.

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
- 2026-08-23: **Slash commands with TUI parity** — composer autocomplete on leading `/` (keyboard ↑↓/Tab/Enter/Esc, smart-click: executes arg-less commands immediately, fills `/name ` for `$ARGUMENTS` ones); routing in `useOpencode.submit`: built-ins (`/new /undo /redo /compact /fork /share /unshare /models /agents /variants /thinking /themes /scheme /next /prev /diff /settings /help /exit`) mapped to existing SDK calls + server registry commands via `POST /session/:id/command`. Registry from `GET /command` (built-ins are TUI-side upstream; extracted the set from the binary). Hot reload: refetch on menu open / window focus / `.opencode` watcher events; **limit documented: new command files need an app restart** (server scans command dirs once at boot — verified). Shared centered dialog extracted (`Dialog.tsx` + `dialog.css`), DiffPanel refactored onto it; `/help` lists all commands grouped by source, `/share` shows URL + copy. Verified headless: probe command registered at startup, `session.command` round-trip replies PROBE_OK (free model), fork carries history to a new session. `npm run build` green.
- 2026-08-23: **Agent cycling** — Tab keybind (TUI parity) + clickable agent chip in the composer model row cycle primary agents (`GET /agent`, subagents/hidden internals filtered); selection rides on every prompt/command body as `agent`. Chip icon rests accent-cyan with glow.
- 2026-08-23: **Thinking effort variants + reasoning display** — runtime `config.providers` exposes per-model `variants` maps (verified shape `{low:{…},high:{…}}`; SDK types stale); `/variants` opens a picker dialog, gauge chip appears when non-default, choice is remembered per model (localStorage `oc.variants`, survives model switches / workspace changes / relaunch) and rides on every send/command as `variant` (round-trip verified headless: request accepted, user msg stores `model.variant:"high"`). Reasoning parts now render as dim italic mono blocks gated by persisted `showThinking` setting; `/thinking` toggles live.
- 2026-08-23: **Attachments (images / video / files)** — paperclip picker, clipboard paste and drag-drop onto the composer (tauri.conf `dragDropEnabled:false` re-enables HTML5 drops); files stage as chips with FileReader read-progress (sequential queue), 50 MB cap inline-rejects; SHA-256 dedupe cache (app lifetime) skips re-reads of known files, same-bytes-in-draft rejected; capability-aware via `GET /provider` — SDK types stale again (runtime nests under `capabilities.{attachment,input}`, input a boolean map); metadata is **advisory only** (verified lying for Zen free models: reports no-image while ox alpha ingests PNGs fine), so nothing hard-blocks — tooltip lists claimed inputs, unsupported types surface as a provider error on send. Transport: `session.prompt` file parts `{type:"file",mime,filename,url:dataURL}`; sent and history-loaded parts render as image preview / video player / icon chip. **Outbound queue**: prompting a streaming session now queues FIFO per session (was silently dropped before) with sidebar count badge, flushed on assistant `time.completed` / `session.idle`, cleared on abort/delete. Verified headless (free model): data-URL PNG round-trip accepted, reply describes the pixel, stored user message keeps the file part. `npm run build` green.
- 2026-08-23: **Fix: duplicated streaming text** — deltas that arrive before both their part and message are stashed; when the message was created from queued orphan parts, the stale stash survived and `flushDeltas` re-appended it (duplicate prefix until the next authoritative `part.updated` cleaned it up). Orphan-flush now drops stashes for materialized parts, same authority rule as `upsertPart`. Verified via SSE-order probe: assistant text parts start empty and grow by deltas only, snapshots carry full text.
- 2026-08-23: **Fix: working state dropped mid-turn + tool-call rendering overhaul** — SSE trace proved heavy turns span MULTIPLE assistant messages (created=4 in one turn) with mid-turn `message.completed` and a `session.idle` while 2/4 still ran; old code cleared busy on each. New per-session inflight-message set: busy clears only when the last live message drains, early idles are ignored, and queue flush waits for true settle (idle + empty set). Tool parts now render as collapsible blocks (per-tool icon, streamed title, duration on completion, mono input/output body, auto-expand on error/short output) replacing the bare status line; retry / compaction / patch-chips / agent-subtask part types render as notice lines; step-finish shows tokens+cost; session-wide totals (cost+tokens from the authoritative store) display as a composer chip.
- 2026-08-23: **Fix: Send/Stop flapping at step boundaries** — draining one assistant message dropped the indicators during the inference gap before the next message of the same turn started (Stop vanished mid-work, sometimes until the next tool call). Settles now go through a 1.5s grace timer (`settleSession`): canceled when the next assistant message starts, otherwise it drops the indicators, plays the reply bell, and drains the queued prompt. Queue-flush guard switched to the inflight set (busyRef lags a render behind post-settle).
- 2026-08-25: **Tuya voice light control added** — cloud API path chosen over local LAN control (local keys would still require one-time cloud access; LAN protocol 3.4/3.5 in Rust is real work) and over MCP/agent control (token cost + seconds of latency vs sub-second direct calls). Voice-only scope per user: no panel, no agent tool. Discovery uses `/v1.0/users/{uid}/devices` — requires the user to paste their Smart Life account UID once (visible on the platform's Linked Accounts / device list UI); confirmed pattern via community Tauri+Tuya projects.
