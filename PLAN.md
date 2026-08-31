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
│  GUI  — Tauri v2 + React            │   ~8 MB exe (+ sidecar)
│  - Vite + React + TypeScript        │
│  - @opencode-ai/sdk                 │   Uses OS WebView2 (no bundled Chromium)
│  - SSE → live message feed          │
├─────────────────────────────────────┤
│  Sidecar process                    │   Spawned/killed by the app
│  opencode serve --port <free port>  │   Official release binary (~170 MB)
└─────────────────────────────────────┘
```

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Start minimal, add more later | Chat loop shipped first; MVP complete — extras live in IMPLEMENTED.md |
| UI base | Fresh minimal UI from scratch | Smallest, no legacy to maintain |
| Platform | Windows only | Matches dev machine; WebView2 ships with Windows |
| Frontend | React | User preference |
| Shell | Tauri v2 | ~10–20× smaller than Electron; reuses OS webview |
| Server | Bundled `opencode serve` sidecar | Reuse all agent logic; zero reimplementation |

## Stack

- **Tauri v2** — window, process management, packaging (+ plugins: window-state, autostart, dialog, global-shortcut, clipboard, single-instance)
- **Vite + React + TypeScript** — frontend
- **@opencode-ai/sdk** (`/client` subpath) — typed API client; `src/api.ts` Proxies `?directory=` onto every call for workspace switching without sidecar respawn
- **opencode release binary** — sidecar (`bundle.externalBin` in `tauri.conf.json`)
- Markdown: `react-markdown` + `remark-gfm` + `lowlight` / `rehype-highlight`
- Terminal: `xterm.js` + Rust `portable-pty` (ConPTY)
- Voice: whisper.cpp + piper TTS (GPU = NVIDIA cublas build, optional), `@ozymandiasthegreat/vad` (WebRTC VAD, embedded wasm) for hands-free speech detection, `double-metaphone` + `an-array-of-english-words` for typo tolerance

> **Design rules** (spacing unit, glass/acrylic material, accent system, blocky
> chrome, icons, fonts, persistence keys) are codified in [AGENTS.md](./AGENTS.md)
> and apply to every new UI element.

### Frontend architecture

```
src/
├── main.tsx              entry (+ Font Awesome, tokens/layout, workspace hydration)
├── App.tsx               thin shell → renders ChatPage
├── api.ts                opencode client singleton (Proxy merges ?directory=; SSE URL too)
├── types.ts              shared local types (Msg, PermAsk, QuestionAsk, ProviderGroup, OpenCodeEvent)
├── lib/                  pure helpers (no React): sounds, workspace, themes, voiceRouter/voiceLexicon,
│                         slashCommands, sessionStore/busyTracker, models, attachments, drafts, hotkeys, etc.
├── hooks/                all server/stateful logic: useOpencode (boot/SSE/sessions/send/queue/permissions),
│                         useProviders (models/variants/capabilities), useSettings (oc.settings blob),
│                         useVoice/useSpeech/useVoiceInstall, usePlugins, useGlobalShortcuts, etc.
├── components/           presentational (one CSS file each in src/styles/): Titlebar, Sidebar, FileTree,
│                         FileEditor, MessageList, Composer, PermissionBar/QuestionPopup, Terminal,
│                         DiffPanel, GitPanel, BrowserBar, SettingsDrawer, Dialog, etc.
├── pages/
│   └── ChatPage.tsx      composes hook + components into the main screen
└── styles/               tokens, layout, sidebar, chat, composer, permission, diff, files, file-editor,
                          settings, tooltip, terminal, etc. — imported by owning components
```

Rule of thumb: state and server talk live in `hooks/`; anything visual is a `component/` that takes props; a screen is a `page/` that wires them together.

Runtime plugins (`src/lib/plugins.ts`, `src/hooks/usePlugins.ts`) extend voice intents, slash commands, hotkeys, settings/sidebar/titlebar/overlay slots and lexicon. Config and plugins live under `%USERPROFILE%\.config\.opencode-gui\` (`themes.json`, `plugins/`).

## Phases

### Phase 1 — Scaffold ✅ 2026-08-23
- Create Tauri v2 app via `npm create tauri-app@latest` (React + TS template).
- Strip template boilerplate.
- `npm install @opencode-ai/sdk`.
- Configure the `opencode.exe` binary as Tauri sidecar resource.

### Phase 2 — Server lifecycle (Rust/Tauri side) ✅ 2026-08-23
- On launch: spawn `opencode serve --port <free-port>` (Windows Job Object `KILL_ON_JOB_CLOSE`).
- Kill child process on window close / app exit.
- Pass base URL into the webview (`server_url` command).

### Phase 3 — Minimal chat client (React) ✅ 2026-08-23
*(grew well past minimal — feature log lives in [IMPLEMENTED.md](./IMPLEMENTED.md))*
Components:
- **Session sidebar** — list sessions (`session.list()`), new-session button (`session.create()`).
- **Chat view** — message list rendering text parts; input → `session.prompt_async()`; live updates via SSE (`/event` → `message.updated` / `message.part.updated` / `message.part.delta`); markdown rendering.
- **Model picker** — grouped dropdown from `config.providers()`.
- **Permission dialog** — Approve/Deny → `POST /session/:id/permissions/:permissionID` (required even in MVP).
- **Abort button** while streaming (`session.abort()`).

### Phase 4 — Package & verify ✅ 2026-08-23
- `npm run tauri build` → MSI/NSIS installers (41–60 MB) + portable zip (exe + sidecar); cold start ~1.5 s.
- Smoke test with free model: create session → prompt → streamed reply → permission approval → abort mid-stream.
- Further polish (themes, file tree, diff, revert, slash commands, terminal, voice, git, attachments, plugins) tracked in [IMPLEMENTED.md](./IMPLEMENTED.md).

## Key server APIs used

| Purpose | Endpoint / SDK call |
|---|---|
| Health check | `GET /global/health` |
| Live events (SSE) | `GET /event?directory=` (per-workspace, `EventSource`) |
| List / create / delete sessions | `session.list()` / `session.create()` / `session.delete()` |
| Send prompt | `session.prompt_async()` (text + file parts, `model`/`agent`/`variant`) |
| Stream updates | `/event` → `message.updated`, `message.part.updated`, `message.part.delta`, `session.idle/compacted` |
| Model/provider list + capabilities | `config.providers()` + `GET /provider` |
| Agents / variants | `GET /agent` (`app.agents()`) |
| Approve/deny tool | `POST /session/:id/permissions/:permissionID` |
| Ask / answer questions | `GET /question`, `POST /question/:id/reply` |
| Abort generation | `session.abort()` |
| Revert / fork / share | `session.revert` / `session.unrevert` / `session.fork` / `session.share` |
| File browse + read | `GET /file` · `GET /file/content` |
| Session diff | `GET /session/:id/diff` (unified patch) |
| Commands / skills | `GET /command` · `POST /session/:id/command` |
| Summarize / compact | `session.summarize()` |

Full API: https://opencode.ai/docs/server · SDK: https://opencode.ai/docs/sdk

## Explicitly deferred

Add after the chat loop is solid:
- ~~File tree browser (`/file?path=...`)~~ ✅ — sidebar Files tab
- ~~Diff viewer (`GET /session/:id/diff`)~~ ✅ — DiffPanel overlay
- ~~Session revert/undo (`session.revert/unrevert`)~~ ✅ — hover rewind + banner
- ~~Themes~~ ✅ — 14 built-in palettes × dark/light via `themes.json`
- ~~Slash-command autocomplete~~ ✅ — built-ins + registry + plugin slash (`/help`, `/share`, etc.)
- ~~Terminal~~ ✅ — bottom dock (xterm + ConPTY)
- ~~Voice (STT/TTS)~~ ✅ — whisper + piper, barge-in, multilingual translate fallback
- macOS/Linux builds — still deferred (Windows only)
- Session share (`session.share`) / multi-project extras — declined by user (multi-workspace via `?directory=` covers the need)

## Skipped — add if ever needed

Command palette UI, fuzzy search over commands. Hot-reload of command files is bounded by upstream (server scans once at boot). Further OS integrations beyond the current Tauri plugins only on demand.
