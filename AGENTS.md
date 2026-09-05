# Project

Thin cross-platform GUI for [opencode](https://opencode.ai) — Tauri v2 + React spawns an `opencode serve` sidecar and talks to it over HTTP/SSE via `@opencode-ai/sdk`. **Do not fork opencode**; all agent/provider/session logic is reused from the server.

## Platform support

| OS | Arch | Status | WebView | Bundle |
|---|---|---|---|---|
| Windows 10/11 | x64 | **Production** | WebView2 | MSI + portable zip |
| macOS 13+ | arm64 (Apple Silicon) | **Production — implemented, same design** | WKWebView | DMG + .app.tar.gz (unsigned) |
| Linux (Ubuntu 22.04+) | x64 + arm64 | **Testing phase** | WebKitGTK 4.1 | deb + AppImage |

Design is identical on all platforms (single CSS/design system, custom titlebar, 6px unit, cyan accent, glass). macOS uses native vibrancy + traffic-light inset; Linux falls back to opaque when no compositor.

## Stack & Constraints

- **Tauri v2 + Vite + React 19 + TypeScript 5.8.** Node 20+, Rust stable. Windows: MSVC Build Tools; macOS: Xcode CLT; Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`.
- **WebView:** WebView2 (Windows), WKWebView (macOS), WebKitGTK (Linux) — selected automatically by Tauri/wry, no bundled Chromium.
- **Server lifecycle (Rust):** `src-tauri/src/lib.rs` spawns/kills `opencode serve --port <free-port>`, Windows Job Object (`KILL_ON_JOB_CLOSE`) so orphans die on crash. Modules: `platform`/`browser`/`voice`/`git`/`pty`/`terminals`/`discord`/`update`/`autostart` — all registered in `invoke_handler`.
- **Platform abstraction:** `src-tauri/src/platform.rs` centralizes `home_dir()` (`HOME` → `USERPROFILE` → `temp_dir`), `config_dir()` (`app.path().app_config_dir()` — `~/Library/Application Support` on mac, `~/.config` on Linux, `%APPDATA%` on Windows), `themes_dir()`/`plugins_dir()`, `open_path()`/`reveal_path()`/`reveal_dir()` (`open`/`xdg-open`/`explorer`), `sidecar_candidates()`, `default_shell()`, `curl_bin()`. Do not reintroduce `USERPROFILE` or `xdg-open`-on-mac.
- **Sidecar binary** `src-tauri/binaries/opencode-*` is **not committed**; `setup` downloads the correct triple from releases. Candidates per OS: `src-tauri/src/platform.rs:sidecar_candidates()` (`opencode-aarch64-apple-darwin`, `opencode-x86_64-unknown-linux-gnu`, etc.; `opencode-x86_64-pc-windows-msvc.exe` on Windows). `tauri.conf.json:bundle.externalBin` is `binaries/opencode` (Tauri appends triple).
- **Single SDK client:** `src/api.ts:23-44` wraps `createOpencodeClient` in a `Proxy` that injects `?directory=` on every call. Use `opencodeFor(dir)` / `serverFetchFor(dir, path)` for multi-workspace; empty `""` = server cwd (`home_dir()`).
- **SSE:** one `EventSource` per workspace (≤5, `src/hooks/useOpencode.ts:844-861`), filtered by `?directory=`, polled/added/removed live. Keep `useOpencode.ts` as the single source of server state.
- **Glass:** `src-tauri/src/lib.rs:apply_glass()` — Windows `apply_acrylic`, macOS `apply_vibrancy(Sidebar)`, Linux no-op. Frontend `html.no-glass` fallback paints opaque. `window-vibrancy` is gated `cfg(any(windows, macos))` in `src-tauri/Cargo.toml`.
- **Tauri config:** `src-tauri/tauri.conf.json` (`targets: "all"`, `bundle` icons include `icon.icns` + `icon.ico`), mac-only `src-tauri/tauri.macos.conf.json` adds `titleBarStyle: Overlay` + `hiddenTitle`. Do not put mac keys in the base config.

## Commands

Via `scripts/run.ps1` (Windows) or `scripts/run.sh` (macOS/Linux/bash) — `run.sh` is fully cross-platform (`uname -s`/`-m` → `opencode-darwin-arm64.zip` etc., `chmod +x`, BSD `sed -i.bak`):

```
run.ps1 setup                          # Windows: npm + Rust deps + download sidecar (x64)
run.sh setup                           # macOS/Linux: npm + download correct triple + chmod +x
run.ps1 dev                            # Vite :1420 + Tauri window (Windows)
run.sh dev                             # same on macOS/Linux (checks any opencode-* binary)
run.sh build [native|win11|win10|both] [bundles]  # native = current OS; win11/win10 only on Windows
run.ps1 build [win11|win10|both] [msi nsis]       # MSI → src-tauri/target/release/bundle
run.ps1 portable [win11|win10|both]    # zip (exe + sidecar) → bundle/portable (Windows only; mac/Linux use build)
run.sh check | run.ps1 check           # tsc + vite build + cargo check
run.sh clean | run.ps1 clean           # cargo clean + remove dist
```

Direct: `npm run dev` / `npm run build` / `npm run tauri build -- --target <triple>`.

## Frontend architecture

- **Hooks** (`src/hooks/`): server talk + state — `useOpencode.ts` (boot, SSE per-session stores, sessions CRUD, prompt/abort/revert, permissions), `useProviders.ts`, `useSettings.ts`, `usePlugins.ts`, etc.
- **Components** (`src/components/`, one `.css` each in `src/styles/`): visuals only, take props. `pages/` composes them (e.g. `ChatPage.tsx` wires hook + components).
- **Lib** (`src/lib/`): utils — `platform.ts` (`isMac`/`isWindows`/`normWorkspace`/`dedupe*`/`displayHotkey` — single source for workspace case-sensitivity), `sessionStore.ts`, `busyTracker.ts`, `slashCommands.ts`, `workspace.ts` (now `isWindows()`-aware dedup), `sounds.ts`, `models.ts`, `plugins.ts`, etc.
- **API** (`src/api.ts`): `opencode()` singleton (`server_url` invoke → `base` + wrapped client), `hiddenSessions`/`HIDDEN_TITLE="__temp__"` filter, `withDeadline()` for sync prompts.

Rule: new server talk → `hooks/`; new visuals → `components/` + `styles/`; new screen → `pages/` + its own hook. New platform logic → `src-tauri/src/platform.rs` or `src/lib/platform.ts`, not scattered `cfg`.

## Backend (Rust) conventions

- Every Tauri command is `async`, `CREATE_NO_WINDOW` in release (Windows), stderr surfaced verbatim. `dir=""` resolves to server cwd (`platform::home_dir()` / `platform::resolve_workdir()`). See `GIT_PANEL.md` for `git.rs` pattern (`git status --porcelain=v1 -b`, `stage/unstage/discard/commit/push/pull/diff`).
- Frontend mirrors Rust persistence for workspace: `workspace_set`/`workspace_get` in `lib.rs` + `localStorage oc.settings.workspace`.
- App-launching (`browser.rs:open_app`/`window_app` — Start Menu `.lnk` + `where`/`powershell`/`taskkill`) is **Windows-only** (`#[cfg(windows)]`), stubbed on other OS (`Err("moved to plugin")`) — will become a plugin, do not port to `.desktop`/`open -a`.
- Voice GPU (`voice.rs:voice_gpu`, `KOKORO_GPU_DLLS` `.dll`, `SetDllDirectoryW`) is Windows-only; macOS/Linux returns `nvidia:false` and CPU-only TTS/STT. CoreML/MPS deferred.
- Update (`update.rs`) self-updater is Windows-only (`curl.exe` → `curl` via `platform::curl_bin()`, `build_flavor` `macos-arm64`/`linux-*` on other OS); auto-update on mac/Linux returns `Err("only on Windows")` — unsigned builds, no Sparkle yet.
- Terminals (`terminals.rs`): Windows `where`+WSL+WT; Unix `which`+`/etc/shells` (`bash`/`zsh`/`fish`/`pwsh`), WSL/WT gated `cfg(windows)`. PTY (`pty.rs`) uses `platform::default_shell()` (`$SHELL` → `/bin/zsh` on Unix, `powershell.exe` on Windows) and `portable-pty` (ConPTY/forkpty).

## Design rules (applied — keep new UI consistent)

- **Spacing unit: 6px.** All gaps use it (main padding, composer gap, sidebar padding, list rhythm). No ad-hoc margins.
- **Glass material:** translucent `rgba` + `backdrop-filter: blur(14px)` over OS vibrancy/acrylic. Titlebar and session sidebar share identical gradient (`rgba(20,28,35,.14) → rgba(12,17,22,.22)`; horizontal vs vertical). Windows: `apply_acrylic`; macOS: `apply_vibrancy(Sidebar, 12.0)`; Linux: opaque fallback.
- **Titlebar:** custom `decorations:false` + `transparent:true` on all OS (no native chrome). macOS: `tauri.macos.conf.json` adds `titleBarStyle: Overlay` + `hiddenTitle`; CSS `html.mac .titlebar { --traffic-inset: 76px }` clears stoplights (`src/styles/layout.css`, `src/main.tsx` adds `html.mac`). Windows/Linux: `18px` left pad.
- **Main panels are square and flush:** chat stage + composer no radius, ~6px from window edges.
- **Accent:** cyan `--accent:#7fd4d4` + `--accent-glow` (`0 0 Npx` shadows), danger `--danger:#e08f8f`. Hovers tint accent; destructive tint red.
- **Blocky chrome:** square scrollbars, accent thumb + glow on hover; collapse toggle 4px radius with dim resting tint.
- **Icons:** Font Awesome only (`fa-solid`, npm, imported once in `main.tsx`).
- **Fonts:** Inter (UI), JetBrains Mono (chat/mono labels).
- **Cursors:** native (`col-resize` etc.), Windows `.cur` pack via `resize_cursor` invoke with PNG fallback (`main.tsx:54`), locked on body during drags.
- **CRLF:** `FileEditor.tsx` normalizes `\\r\\n` → `\\n` on load; `editorKeys.ts` handles `\\r` in line ops. Save as `\\n`.
- **State persistence:** `localStorage` under `oc.*` (`oc.sb.w`, `oc.sb.c`, `oc.lastSes`, `oc.lastModel`/`oc.sessionModels`, `oc.lastAgent`/`oc.sessionAgents`/`oc.disabledAgents`, `oc.variants`/`oc.sessionVariants`, `oc.securityMode`/`oc.sessionSecurityMode` — per-session overrides that fall back to global last for new chats, `oc.settings` with `workspace`+`workspaces[≤5]`+`sounds`, `oc.git.open`, etc.) — validated before use. Workspace dedup is case-sensitive on mac/Linux (`src/lib/platform.ts:normWorkspace()`), case-insensitive on Windows.

## Gotchas

- **Workspace dir:** always `getDirectory()` / `opencodeFor(dir)` — never hardcode paths; empty string is valid. Dedup via `src/lib/platform.ts:normWorkspace()`, not `toLowerCase()`.
- **Hidden sessions:** `tempSession()` creates `title="__temp__"` + `hiddenSessions` Set (`src/api.ts:110-127`); `refreshSessions` drops them and `parentID` sessions.
- **Deadlines:** sync prompts hang forever on stalled provider — wrap with `withDeadline()` (`src/api.ts:131-145`).
- **File watcher:** `file.watcher.updated` → `oc:file-changed` event; command/agent registries refetched throttled (1s), but **new** command files need sidecar restart (server scans once at boot). `lib.rs` watches both `platform::themes_dir()`/`plugins_dir()` and legacy `USERPROFILE/.config` for migration.
- **SSE staleness:** `useOpencode.ts` keeps authoritative per-session `sessionStore`; mid-stream `message.updated/part.updated/delta` is newer than `session.messages` fetch — don't reset busy sessions from fetch.
- **Hotkeys:** `src/lib/hotkeys.ts:formatBinding()` shows `⌘` on mac; `useGlobalShortcuts.ts` gates `Alt+Space` to non-mac (`Alt+Space` is not system menu on mac; `Cmd+Space` is Spotlight), `Ctrl+wheel` also accepts `metaKey`.
- **Platform files:** `src-tauri/src/platform.rs` + `src/lib/platform.ts` are the single source for OS branches — do not add new `USERPROFILE`/`xdg-open`/`where` scattered.
- **No new deps** for what few lines / stdlib / CSS / native `<input>` / DB constraint can do. Reuse existing `lib/` helper before writing a new one.

## Testing / API usage / Verify

- **NEVER test using the user's own API keys or paid quotas** (`~/.local/share/opencode/auth.json` or provider keys in config).
- For any live-model test, use free models only: `opencode/x-preview-f-free` if available, else other OpenCode Zen free-tier models (`opencode/nemotron-3.5-lightning-free`, `opencode/mimo-v2.5-free`, etc. — check `/config/providers` → `opencode` provider). If none, ask before spending.
- **Verify:** `run.ps1 check` / `run.sh check` (or `npx tsc --noEmit && cargo check`). Smoke: create session → `prompt_async` → streamed SSE reply → permission approve/deny → abort mid-stream (`PLAN.md:119-122` in git history; plan docs removed in `56b2e48`).
- **Cross-platform verify:** `run.sh setup` on mac arm64 / Linux x64+arm64 → `run.sh build` → `bundle/{dmg,app.tar.gz,deb,AppImage}`; `cargo check --target aarch64-apple-darwin` / `x86_64-unknown-linux-gnu` on CI. CI matrix in `.github/workflows/release.yml` (Windows `x64` MSI, macOS `aarch64-apple-darwin` DMG, Linux `x64`+`arm64` deb/AppImage) — unsigned, no notarization yet.
