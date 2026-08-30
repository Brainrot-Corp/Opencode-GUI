# Project

Thin Windows GUI for [opencode](https://opencode.ai) — Tauri v2 + React spawns an `opencode serve` sidecar and talks to it over HTTP/SSE via `@opencode-ai/sdk`. **Do not fork opencode**; all agent/provider/session logic is reused from the server. See `PLAN.md` for the full architecture tree.

## Stack & Constraints

- **Platform:** Windows 10/11 only. WebView2 (no bundled Chromium), Tauri v2, Vite + React 19 + TypeScript 5.8. Node 20+, Rust stable + MSVC Build Tools.
- **Server lifecycle (Rust):** `src-tauri/src/lib.rs` spawns/kills `opencode serve --port <free-port>`, Job Object (`KILL_ON_JOB_CLOSE`) so orphans die on crash. Modules: `browser`/`voice`/`git`/`pty`/`terminals`/`discord`/`update`/`autostart` — all registered in `invoke_handler`.
- **Sidecar binary** `src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe` is **not committed**; `setup` downloads it from opencode releases.
- **Single SDK client:** `src/api.ts:23-44` wraps `createOpencodeClient` in a `Proxy` that injects `?directory=` on every call. Use `opencodeFor(dir)` / `serverFetchFor(dir, path)` for multi-workspace; empty `""` = server cwd (`USERPROFILE`).
- **SSE:** one `EventSource` per workspace (≤5, `src/hooks/useOpencode.ts:844-861`), filtered by `?directory=`, polled/added/removed live. Keep `useOpencode.ts` as the single source of server state.

## Commands

Via `scripts/run.ps1` (PowerShell) or `scripts/run.sh` (bash/WSL) — see `README.md:14-22`:

```
run.ps1 setup                          # first time: npm + Rust deps + download sidecar
run.ps1 dev                            # Vite :1420 + Tauri window
run.ps1 build [win11|win10|both] [msi nsis]  # MSI → src-tauri/target/release/bundle
run.ps1 portable [win11|win10|both]    # zip (exe + sidecar) → bundle/portable
run.ps1 check                          # tsc + vite build + cargo check
run.ps1 clean                          # cargo clean + remove dist
```

Direct: `npm run dev` / `npm run build` / `npm run tauri build`.

## Frontend architecture

- **Hooks** (`src/hooks/`): server talk + state — `useOpencode.ts` (boot, SSE per-session stores, sessions CRUD, prompt/abort/revert, permissions), `useProviders.ts`, `useSettings.ts`, `usePlugins.ts`, etc.
- **Components** (`src/components/`, one `.css` each in `src/styles/`): visuals only, take props. `pages/` composes them (e.g. `ChatPage.tsx` wires hook + components).
- **Lib** (`src/lib/`): utils — `sessionStore.ts`, `busyTracker.ts`, `slashCommands.ts`, `workspace.ts`, `sounds.ts`, `models.ts`, `plugins.ts`, etc.
- **API** (`src/api.ts`): `opencode()` singleton (`server_url` invoke → `base` + wrapped client), `hiddenSessions`/`HIDDEN_TITLE="__temp__"` filter, `withDeadline()` for sync prompts.
- Full tree and conventions in `PLAN.md:50-88`. Rule: new server talk → `hooks/`; new visuals → `components/` + `styles/`; new screen → `pages/` + its own hook.

## Backend (Rust) conventions

- Every Tauri command is `async`, `CREATE_NO_WINDOW` in release, stderr surfaced verbatim. `dir=""` resolves to server cwd. See `GIT_PANEL.md` for `git.rs` pattern (`git status --porcelain=v1 -b`, `stage/unstage/discard/commit/push/pull/diff`).
- Frontend mirrors Rust persistence for workspace: `workspace_set`/`workspace_get` in `lib.rs` + `localStorage oc.settings.workspace`.

## Design rules (applied — keep new UI consistent)

- **Spacing unit: 6px.** All gaps use it (main padding, composer gap, sidebar padding, list rhythm). No ad-hoc margins.
- **Glass material:** translucent `rgba` + `backdrop-filter: blur(14px)` over OS acrylic/mica. Titlebar and session sidebar share identical gradient (`rgba(20,28,35,.14) → rgba(12,17,22,.22)`; horizontal vs vertical).
- **Main panels are square and flush:** chat stage + composer no radius, ~6px from window edges.
- **Accent:** cyan `--accent:#7fd4d4` + `--accent-glow` (`0 0 Npx` shadows), danger `--danger:#e08f8f`. Hovers tint accent; destructive tint red.
- **Blocky chrome:** square scrollbars, accent thumb + glow on hover; collapse toggle 4px radius with dim resting tint.
- **Icons:** Font Awesome only (`fa-solid`, npm, imported once in `main.tsx`).
- **Fonts:** Inter (UI), JetBrains Mono (chat/mono labels).
- **Cursors:** native Windows only (`col-resize` etc.), locked on body during drags.
- **State persistence:** `localStorage` under `oc.*` (`oc.sb.w`, `oc.sb.c`, `oc.lastSes`, `oc.lastModel`/`oc.sessionModels`, `oc.lastAgent`/`oc.sessionAgents`/`oc.disabledAgents`, `oc.variants`/`oc.sessionVariants`, `oc.securityMode`/`oc.sessionSecurityMode` — per-session overrides that fall back to global last for new chats, `oc.settings` with `workspace`+`workspaces[≤5]`+`sounds`, `oc.git.open`, etc.) — validated before use.

## Gotchas

- **Workspace dir:** always `getDirectory()` / `opencodeFor(dir)` — never hardcode paths; empty string is valid.
- **Hidden sessions:** `tempSession()` creates `title="__temp__"` + `hiddenSessions` Set (`src/api.ts:110-127`); `refreshSessions` drops them and `parentID` sessions.
- **Deadlines:** sync prompts hang forever on stalled provider — wrap with `withDeadline()` (`src/api.ts:131-145`).
- **File watcher:** `file.watcher.updated` → `oc:file-changed` event; command/agent registries refetched throttled (1s), but **new** command files need sidecar restart (server scans once at boot).
- **SSE staleness:** `useOpencode.ts` keeps authoritative per-session `sessionStore`; mid-stream `message.updated/part.updated/delta` is newer than `session.messages` fetch — don't reset busy sessions from fetch.
- **No new deps** for what few lines / stdlib / CSS / native `<input>` / DB constraint can do. Reuse existing `lib/` helper before writing a new one.

## Testing / API usage / Verify

- **NEVER test using the user's own API keys or paid quotas** (`~/.local/share/opencode/auth.json` or provider keys in config).
- For any live-model test, use free models only: `opencode/x-preview-f-free` if available, else other OpenCode Zen free-tier models (`opencode/nemotron-3.5-lightning-free`, `opencode/mimo-v2.5-free`, etc. — check `/config/providers` → `opencode` provider). If none, ask before spending.
- **Verify:** `run.ps1 check` (or `npx tsc --noEmit && cargo check`). Smoke: create session → `prompt_async` → streamed SSE reply → permission approve/deny → abort mid-stream (`PLAN.md:119-122`).
