# Lightweight OpenCode GUI Client — Project Plan

A minimal Windows desktop GUI built on top of [opencode](https://opencode.ai)'s open source architecture, as light as possible.

## Core idea

**Do not fork opencode.** Opencode is already a client/server app:

- The core agent lives in a headless Go binary: `opencode serve` (HTTP API, OpenAPI 3.1 spec at `/doc`, SSE event stream at `/event`).
- The TUI is just one client of that server.
- Official typed SDK: `@opencode-ai/sdk` (npm).

So we build a **thin GUI client** that spawns and talks to the server. All agent logic (providers, sessions, tools, permissions, file access) is reused for free.

```
┌─────────────────────────────────────┐
│  GUI  — Tauri v2 + React            │   ~5–10 MB installer
│  - Vite + React + TypeScript        │
│  - @opencode-ai/sdk                 │   Uses OS WebView2 (no bundled Chromium)
│  - SSE → live message feed          │
├─────────────────────────────────────┤
│  Sidecar process                    │   Spawned/killed by the app
│  opencode serve --port <free port>  │   Official release binary (~30 MB)
└─────────────────────────────────────┘
```

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Start minimal, add more later | Ship the chat loop first |
| UI base | Fresh minimal UI from scratch | Smallest, no legacy to maintain |
| Platform | Windows only | Matches dev machine; WebView2 ships with Windows |
| Frontend | React | User preference |
| Shell | Tauri v2 | ~10–20x smaller than Electron; reuses OS webview |
| Server | Bundled `opencode serve` sidecar | Reuse all agent logic; zero reimplementation |

## Stack

- **Tauri v2** — window, process management, packaging
- **Vite + React + TypeScript** — frontend
- **@opencode-ai/sdk** — typed API client
- **opencode release binary** — sidecar (`externalBin` in `tauri.conf.json`)
- Markdown rendering lib for assistant output

> **Design rules** (spacing unit, glass/acrylic material, accent system, blocky
> chrome, icons, fonts, persistence keys) are codified in [AGENTS.md](./AGENTS.md)
> and apply to every new UI element.

### Frontend architecture (since 2026-08-23 restructure)

```
src/
├── main.tsx              entry (+ Font Awesome import, styles split load)
├── App.tsx               thin shell → renders ChatPage
├── api.ts                opencode client singleton (server_url → SDK client;
│                         Proxy merges ?directory= into every call — workspace
│                         switching without sidecar respawn)
├── types.ts              shared local types (Msg, PermAsk, ProviderGroup, OpenCodeEvent)
├── lib/
│   ├── sounds.ts         WebAudio UI sound pack + persisted prefs
│   └── workspace.ts      workspace picker → persists oc.settings, reloads webview
├── hooks/
│   ├── useOpencode.ts    ALL server state + actions: boot, SSE stream (per-session
│   │                     stores), sessions CRUD, send/abort, revert/unrevert,
│   │                     permission responses
│   └── useSettings.ts    oc.settings blob (theme/mode/colors/uiScale/sounds/workspace)
├── components/
│   ├── Titlebar.tsx      frameless chrome: drag, pin (always-on-top), theme/mode selects, settings
│   ├── Sidebar.tsx       Chats/Files tabs, collapse toggle + width resize (persisted)
│   ├── FileTree.tsx      lazy directory browser; opens FileEditor for files
│   ├── FileEditor.tsx    centered editable file viewer (portal modal, highlight
│   │                     overlay, auto-save toggle, Ctrl+S/Z/Y, find+replace,
│   │                     file.watcher.updated external-change reload)
│   ├── MessageList.tsx   markdown rendering, tool lines, autoscroll follower, hover rewind
│   ├── Composer.tsx      input, model picker, workspace + diff toggles, send/stop
│   ├── PermissionBar.tsx approve/deny floating dialog
│   ├── DiffPanel.tsx     session diff overlay (colors the server's unified patch)
│   ├── SettingsDrawer.tsx themes, custom colors, ui scale, sounds, workspace
│   ├── ThemeSelect.tsx   titlebar theme dropdown
│   └── TooltipLayer.tsx  global data-tip renderer
├── pages/
│   └── ChatPage.tsx      composes hook + components into the main screen
└── styles/               tokens, layout, sidebar, chat, composer, permission,
                          diff, files, file-editor, settings, tooltip — imported by owning components
```

Rule of thumb: state and server talk live in `hooks/`; anything visual is a `component/` that takes props; a screen is a `page/` that wires them together. New screens go in `pages/` and get wired to their own hook.

## Phases

### Phase 1 — Scaffold ✅ 2026-08-23
- Create Tauri v2 app in `E:\project\ai assistant` via `npm create tauri-app@latest` (React + TS template).
- Strip template boilerplate.
- `npm install @opencode-ai/sdk`.
- Configure the `opencode.exe` binary as Tauri sidecar resource.

### Phase 2 — Server lifecycle (Rust/Tauri side) ✅ 2026-08-23
- On launch: spawn `opencode serve --port <free-port>`.
- Kill child process on window close / app exit.
- Pass base URL into the webview.
- *(health polling replaced by first-request retry in the client)*

### Phase 3 — Minimal chat client (React) ✅ 2026-08-23
*(grew well past minimal — feature log lives in [IMPLEMENTED.md](./IMPLEMENTED.md))*
Components:
- **Session sidebar** — list sessions (`session.list()`), new-session button (`session.create()`).
- **Chat view**
  - Message list rendering text parts.
  - Input box → `session.prompt_async()`.
  - Live updates via SSE (`event.subscribe()`), filtering `message.updated` / `message.part.updated`.
  - Markdown rendering for assistant messages.
- **Model picker** — dropdown fed by `config.providers()`.
- **Permission dialog** — on permission-request event: Approve/Deny → `POST /session/:id/permissions/:permissionID`. *Required even in MVP; without it the agent cannot run tools.*
- **Abort button** while streaming (`session.abort()`).

### Phase 4 — Package & verify ⏳
- `npm run tauri build` → verify installer size and cold-start time.
- Smoke test with a real provider API key: create session → prompt → streamed reply → permission approval → abort mid-stream.
- *(dev-run only so far; installer build pending)*

## Key server APIs used

| Purpose | Endpoint / SDK call |
|---|---|
| Health check | `GET /global/health` |
| Live events (SSE) | `GET /global/event` or `event.subscribe()` |
| List sessions | `session.list()` |
| Create session | `session.create()` |
| Send prompt | `session.prompt_async()` |
| Stream updates | `/event` SSE → `message.updated`, `message.part.updated` |
| Model/provider list | `config.providers()` |
| Approve/deny tool | `POST /session/:id/permissions/:permissionID` |
| Abort generation | `session.abort()` |
| Revert / undo rewind | `POST /session/:id/revert` · `POST /session/:id/unrevert` |
| File browse + read | `GET /file` · `GET /file/content` |
| Session diff | `GET /session/:id/diff` |
| Commands (planned) | `GET /command` · `POST /session/:id/command` |

Full API reference: https://opencode.ai/docs/server · SDK: https://opencode.ai/docs/sdk

## Explicitly deferred

Add after the chat loop is solid:

- ~~File tree browser (`/file?path=...`)~~ ✅ 2026-08-23 — sidebar "Files" tab
- ~~Diff viewer for agent edits (`GET /session/:id/diff`)~~ ✅ 2026-08-23 — composer toggle → DiffPanel overlay
- ~~Session revert/undo (`session.revert/unrevert`)~~ ✅ 2026-08-23 — hover rewind on user messages + undo banner
- Session share (`session.share`) — declined by user
- Themes ✅ (theme system v2), keybinds
- Multi-project support — declined by user
- macOS/Linux builds
- ~~Slash-command autocomplete (`GET /command` registry: built-ins + config/markdown +
  plugin-registered commands + skills → `POST /session/:id/command`)~~ ✅ 2026-08-23 —
  composer autocomplete + 16 built-ins (new/undo/redo/compact/fork/share/unshare/
  models/agents/themes/scheme/next/prev/diff/settings/help/exit) /help + /share dialogs

## Skipped — add if ever needed

Command palette UI, fuzzy search over commands. No v1.18 server API exists for model
variants, session archive, or session export → those TUI commands can't be mapped yet;
hot-reload of command files is bounded by upstream (server scans once at boot).
