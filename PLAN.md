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
├── main.tsx              entry
├── App.tsx               thin shell → renders ChatPage
├── api.ts                opencode client singleton (Tauri server_url → SDK client)
├── types.ts              shared local types (Msg, PermAsk, ProviderGroup, OpenCodeEvent)
├── styles.css            REMOVED → src/styles/ split by concern:
│                           tokens.css (design vars/base/grain) + layout.css (shell/titlebar)
│                           loaded once in main.tsx; sidebar/chat/composer/permission.css
│                           imported by their owning components
├── hooks/
│   └── useOpencode.ts    ALL app state + actions: boot, SSE event stream,
│                         sessions CRUD, send/abort, permission responses
├── components/           reusable, presentational (props in, callbacks out)
│   ├── Titlebar.tsx      custom window chrome (drag region, min/max/close)
│   ├── Sidebar.tsx       session list
│   ├── MessageList.tsx   message rendering + markdown + tool lines + autoscroll
│   ├── Composer.tsx      input box + model picker + send/stop
│   └── PermissionBar.tsx approve/deny floating dialog
└── pages/
    └── ChatPage.tsx      composes hook + components into the main screen
```

Rule of thumb: state and server talk live in `hooks/`; anything visual is a `component/` that takes props; a screen is a `page/` that wires them together. New screens go in `pages/` and get wired to their own hook.

## Phases

### Phase 1 — Scaffold
- Create Tauri v2 app in `E:\project\ai assistant` via `npm create tauri-app@latest` (React + TS template).
- Strip template boilerplate.
- `npm install @opencode-ai/sdk`.
- Configure the `opencode.exe` binary as Tauri sidecar resource.

### Phase 2 — Server lifecycle (Rust/Tauri side)
- On launch: spawn `opencode serve --port <free-port>`.
- Poll `/global/health` until `{ healthy: true }`.
- Kill child process on window close / app exit.
- Pass base URL into the webview.

### Phase 3 — Minimal chat client (React)
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

### Phase 4 — Package & verify
- `npm run tauri build` → verify installer size and cold-start time.
- Smoke test with a real provider API key: create session → prompt → streamed reply → permission approval → abort mid-stream.

## Key server APIs used (MVP)

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
