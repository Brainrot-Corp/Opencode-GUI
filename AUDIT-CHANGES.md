# Audit fixes — master change log

Every change from AUDIT.md applied in 2 waves of 5 parallel agents. All fixes are
behavior-preserving unless noted in the per-wave doc's "Regression watchpoints".

**Result: 49 files changed, +2,233 / −8,859 tracked lines (net −6,626) plus 15 new
files (modules/hooks/lib extracted).** Baseline and both gates green:
`npm run test` 30/30 · `tsc --noEmit` clean · `cargo check --all-targets` clean ·
`cargo test --lib` 18/18.

## Regression-check procedure

1. Per-file diffs are indexed below; each doc's "Regression watchpoints" section lists
   the behaviors its changes could break + a one-line smoke test.
2. Automated: `npm run test && npx tsc --noEmit && cargo check` (from `src-tauri/`).
3. If a regression appears, bisect by wave doc: wave-1 docs = 01–05, wave-2 = 06–09.

## Wave 1 (docs/audit-fixes/01–05)

| Doc | Scope | Highlights |
|---|---|---|
| 01-rust-lib-git.md | git.rs, lib.rs, platform.rs | 15 dead commands deleted (~259 L); `base_dir`→`resolve_workdir`; `which_bin`+`reveal_path` deleted; `platform::win_command`/`free_port` added; file/workspace commands made async (ssh off UI thread) |
| 02-rust-voice-update-misc.md | voice.rs, update.rs, browser.rs, discord.rs, pty.rs, remote.rs, terminals.rs, Cargo.toml | curl downloads `spawn_blocking`; updater zip streams via BufReader (no 2× RAM); relaunch 4→2 tiers; `tts_stream` stubbed; duplicate WAV encoder deleted; **whisper-rs + `whisper` feature removed**; 15 lock().unwrap() hardened; discord/pty/remote async; WSL Lxss loop deduped |
| 03-i18n-dead-code.md | i18n.ts, i18n.test.ts, InfoDialog.tsx, dialog.css, composer.css, chat.css | i18n 1618→935 L (461→238 keys/lang; `plugins.*`+`common.*` preserved as plugin surface); InfoDialog dead Groups/useEqualPills deleted; dead CSS −151 L |
| 04-useopencode.md | useOpencode.ts, useProviders.ts, useFileCache.ts, useTerminalProfiles.ts | 2654→2347 L: one `teardownSession` (fixes childParentRef/debugSessions/lastSentRef leak), `clientFor`, `handlePermAsk`, `inheritChips`, cached applyOverrides, `onEvent` → lib/opencodeEvents.ts (29-member ctx) |
| 05-chatpage.md | ChatPage.tsx + 6 new files | 1567→799 L: voice router → useVoiceRouter (456 L), useChatFind, usePluginUpdates, useTwoStepConfirm, useDragResize, DialogHost, lib/presence |

## Wave 2 (docs/audit-fixes/06–09)

| Doc | Scope | Highlights |
|---|---|---|
| 06-messagelist-parts.md | MessageList.tsx, ToolBlock.tsx, parts/ | 1536→1079 L; 6 sub-features → components/parts/*; shared `partVisible` (rowVisible can't drift from renderPart); quoted-pairs regex → lib/qSummary.ts; find-highlight debounced 150 ms |
| 06b-gitpanel.md | GitPanel.tsx, lib/commitGen.ts | 1375→1304 L; AI commit gen → lib/commitGen.ts; FileRow merge; one memoized settings snapshot per 1s tick; git_watch fires once per repo |
| 07-shared-adoption.md | Composer, Sidebar, SettingsDrawer, Terminal, AgentBoard, FileEditor, 4 dialogs, dialog.css, lib/focus.ts, lib/workspace.ts, DialogTabs.tsx | overlayOpen()/baseName()/DialogTabs deduped; Composer dead listener+empty if removed; recent-models shadow state dropped; `.hk-sub`/`.hk-key` CSS deleted |
| 08-rust-reorg.md | lib.rs→server/input/files/windowctl/plugins/glass, voice.rs→voice/{stt,tts,voice_install}, platform.rs, git.rs, update.rs, terminals, pty, browser, remote | **lib.rs 2441→513 L; voice.rs 1438→46 L**; registration matrix verified 110↔110; git run_root async + timeout honored (push/pull no longer pin workers 120 s); `platform::curl_download` shared; single cmdline tokenizer; hand-rolled b64 → base64 crate |
| 09-misc-hooks-scripts.md | useSpeech, useVoice, useMcp, useProviderAuth, useSettings, main.tsx, themes.ts, speechText.ts, apiErr.ts, voiceEvents.ts, scripts, README, AGENTS | NUL byte removed (file greps as text again); duplicate speech effects merged; withDeadline adopted ×2; apiErr deduped; themeList memoized; cyan.dark = FALLBACK (proven output-identical); **run.ps1 deleted, run.sh single runner**; AGENTS.md updated to new layout |

## Wave 3 (docs/audit-fixes/10–13) — deferred-fix pass

| Doc | Scope | Highlights |
|---|---|---|
| 10-panels-hooks-deferred.md | useDragResize, useTwoStepConfirm, GitPanel, Terminal, AgentBoard | resize hook gained orientation/invert (adopted: GitPanel height, Terminal dock); confirm hook gained `ttlMs: null` + `cancel()` (adopted: GitPanel force-push/discard); **AgentBoard Simulate mode deleted (~200 L, owner-approved)**; AgentBoard 8-handle + Terminal side-panel drags still skipped (geometry/side-channel) |
| 11-message-surface.md | MessageList, ToolBlock, parts/, Composer, Lightbox.tsx | shared `<Lightbox>` replaces 2 inline portals; `PartCtx` context flattens the 4-level prop drill (taskCosts/dir/collapsedDefault/onOpenSubagent); ChatPage unchanged |
| 12-rust-wait-port.md | server.rs, voice/stt.rs, remote.rs | `wait_for_port(port, timeout, http_ok)` unifies the two poll loops — strict for serve/tunnels (default `true`), loose for whisper-server (404 builds stay "up"); stt's local `wait_for_server` deleted; +1 unit test (reply_ok predicate) |
| 13-useopencode-typing-polls.md | useOpencode.ts, opencodeEvents.ts | **`@ts-nocheck` removed — hook fully typed** (24 documented casts remain for stale-SDK fields); 3 s children interval dropped (event triggers + settle edge cover it); 2 s workspace tick → event-driven reconcile (SSE onerror debounce + workspaces-changed), `remoteStatus` only probed for non-open remote streams |

## Wave 4 (docs/audit-fixes/14) — useOpencode split under the new budget rule

useOpencode.ts 2,400 → 1,446 L; the hook is now composition + SSE boot + prompt core.
| New module | Lines | Owns |
|---|---|---|
| useAsks.ts | 454 | permission/question refs, attention, peek/subscribe, ask lifecycle |
| useAgents.ts | 302 | per-session agent pinning (shares `sessionMeta.ts:pinEntry` with useProviders) |
| useWorkspaceSessions.ts | 242 | dir map, getAllDirs, refreshSessions/guardedRefresh |
| useSecurity.ts | 220 | security mode restore/auto-pin/auto-responder + cross-window sync |
| useSessionUsage.ts | 140 | children/cost/usage polling |
| sessionMeta.ts (+ test, 17 checks) | 100 | pinned/title overrides, applyOverrides as pure lib functions |

`opencodeEvents.ts` 321 → 266 L (ask mutations only via ctx). Public return object key-for-key identical; no circular imports. Budget note: hook sits at 1,446 — all six mapped seams are exhausted; the remainder (SSE boot wiring, prompt/submit core, fork/revert/clear) is the audit-designated core of the hook. Splitting it further would be forced fragmentation, not a seam.

## Deliberately deferred (documented, not lost)

- `useOpencode.ts` `@ts-nocheck` removal + full typing (incremental project)
- `update_stage_local` release registration (cfg stub kept; conditional registration not cleanly possible in `generate_handler!`)
- GitPanel `useDragResize`/`useTwoStepConfirm` adoption (hook is horizontal-only / hook lacks cancel — would change confirm timing) — **RESOLVED in wave 3** (hooks extended, adopted)
- Sidebar two-step confirm (per-dir keyed state doesn't fit the boolean hook), Terminal side-panel drag (body-flag side-channel), AgentBoard drags (8-handle geometry)
- SettingsDrawer Esc set (intentionally omits own scrim — not expressible as base+extras)
- `run_captured` helper (3 genuinely different spawn shapes)
- Piper migration shim kept (old installs may hold Piper voice ids; `ponytail:` marked — revisit after a release cycle)
- AgentBoard Simulate mode — **DELETED in wave 3 (owner decision)**
- Google-Fonts self-hosting (needs woff2 assets); accent-dim/glow kept hardcoded (alphas actually span 0.12–0.15 — color-mix would change rendering)
