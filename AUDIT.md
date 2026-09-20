# Full-repo audit — Opencode-GUI (2.2.0)

Scope: over-engineering, dead code, duplication, bad patterns, unoptimized paths, oversized files.
Everything below verified by grep/read against the current tree. Nothing was applied — this is a findings report.

---

## 0. Verdict

The codebase is in better shape than line counts suggest (no unused deps, centralized lib helpers, near-zero CSS duplication, custom virtualization already in place). But there are **~4,100 lines that can be deleted without behavior change**, one giant file that has silently swallowed half the app's state, and a handful of real rework items (blocking the async runtime, main-thread SSH, unbounded memory) that are bug-shaped, not style-shaped.

---

## 1. Rework candidates (real problems, not just size)

| Sev | Finding | Where | Fix |
|---|---|---|---|
| **high** | Blocking downloads pin a tokio worker for up to 30 min (`curl ... --max-time 1800` via blocking `cmd.output()` inside `async fn`) | voice.rs:236 (`voice_download`), update.rs:66 (`update_download`) | Wrap body in `tauri::async_runtime::spawn_blocking` (the pattern already exists at voice.rs:335) |
| **high** | `update_download` reads the **entire release zip into RAM twice** (once for sha256, once for the parse) — ~2× a 300 MB artifact | update.rs:79 + sha256_of (17–23) | File+BufReader for both (voice.rs:256 already fixed the identical bug) |
| **high** | Sync commands doing SSH round-trips run on the **main/UI thread** (ConnectTimeout = 10 s each): `remote_terminals`, `workspace_is_dir`, `file_create/delete/rename/duplicate` on ssh:// paths, `discord_set` (sleep 200 ms + blocking named-pipe connect), `pty_spawn/kill` (fixed sleeps) | remote.rs:840, lib.rs:595–820, discord.rs:110–147, pty.rs:121/350 | Make remote-touching commands async + `spawn_blocking` |
| **high** | 4× session-teardown ritual; none prune `childParentRef` / `debugSessions` / `lastSentRef` → **unbounded Map growth** for deleted sessions | useOpencode.ts:1446–1477, 2316–2357, 2485–2536, 2539–2571 | One `teardownSession(sid)` helper (~55 lines saved, fixes leak) |
| **med** | 15× `lock().unwrap()` — a panic while a lock is held poisons the mutex and every later browser/tiktok invoke panics the callback | browser.rs:119…568 (15 sites) | `unwrap_or_else(\|e\| e.into_inner())` (already used elsewhere in the repo) |
| **med** | `run_blocking`/`run_root` called inline from ~25 async git commands; push/pull/fetch can block a worker 120 s; the `_timeout` param is accepted and **ignored** | git.rs:102–132 | `spawn_blocking` + timeout at the `run_root` boundary (pattern exists at git.rs:530–552); also honors the ignored timeout |
| **med** | GitPanel re-parses `localStorage.oc.settings` on every call **and polls it every 1 s** while settings already flow through `useSettings` | GitPanel.tsx:94–132, 152–166 | Pass settings down; delete the 1 s interval |
| **med** | `applyOverrides` re-`JSON.parse`s two localStorage maps **per SSE `session.created/updated` event** (title auto-gen bursts after first reply) | useOpencode.ts:813–827, call sites 938/1411/1430/2058/2373/2386/2479 | Cache the two maps in refs, invalidate on write |
| **med** | `// @ts-nocheck` on line 1 disables the type checker for all 2,654 lines; pervasive `(client as any).session` masks stale SDK types | useOpencode.ts:1 | Extract event/store layer first (§2), then type it incrementally |
| **low** | Find-highlight walks + rewraps the entire rendered chat DOM **per streaming delta** while find is open | MessageList.tsx:1339–1402 | Debounce 150 ms or pause while busy |
| **low** | Stray literal NUL byte in a string makes grep treat the file as **binary** (silently hides the file from searches — caused a false "dead code" verdict during this audit) | useSpeech.ts:509 | Delete the byte |
| **low** | index.html pulls Inter/JetBrains Mono from fonts.googleapis.com at runtime — offline launches silently fall back | index.html:8–13 | Self-host woff2 |
| **low** | Google-Fonts/StrictMode-era stale comments; `main.tsx` re-implements `isMac()` | ChatPage.tsx:898, TermInstanceView.tsx:265, main.tsx:89–93 | Import `platform.ts:isMac()` |

---

## 2. Files too long — cut plan

| File | Lines | What it swallowed | Cut |
|---|---|---|---|
| **src/hooks/useOpencode.ts** | 2,654 | Server state for the whole app. Clusters: security mode (~215), per-session agent memory (~265), ask/permission plumbing (~480), workspace session listing (~178), SSE boot + `onEvent` mega-switch (**560**), usage polling (~100), prompt/queue core (~165), responders/fork/pin (~390) | Extract `onEvent` → `lib/opencodeEvents.ts` (~560), asks → `useAsks` (~480), security → `useSecurity` (~215), agents pinning → shared with useProviders (~250); one `clientFor(dir)` replaces 16 copies of `dirFor ? opencodeFor(dirFor) : opencode()`. **~1,000+ lines out of the hook, 0 behavior change** |
| **src/pages/ChatPage.tsx** | 1,567 | 15 inline dialogs/overlays, a **510-line voice routing state machine**, plugin-update engine (~85), chat-find implementation (~135), 2 hand-rolled double-press confirms (~110), resize drag, presence mirror | `useVoiceRouter` hook (~500), `usePluginUpdates` (~85), `useChatFind` (~100), shared `useTwoStepConfirm` (~90; also dedups Sidebar/SettingsDrawer/GitPanel/FileEditor), `DialogHost` for the 5 `oc.dialog.kind` conditionals, shared `useDragResize` (dup ×4: ChatPage/GitPanel/Terminal/AgentBoard) |
| **src-tauri/src/lib.rs** | 2,442 | ~1,150 lines are relocatable: server spawn/job object (~270 → `server.rs`), input-repair trio `wininput`+`unpoison_input`+`webfocus`+IPC+`resize_cursor`+shortcuts (~570 → `input.rs`, Windows-only drag), file commands (~210 → `files.rs`), theme/plugin dirs (~160 → `plugins.rs`) | Mechanical moves; lib.rs drops to ~800 with `run()` as the only real core |
| **src/components/MessageList.tsx** | 1,496 | 6 embedded sub-features (AnsweredSummary, TaskResultBlock, TaskMixed, SubtaskBlock, CodePre, Reasoning) inside one file; 120-line `renderPart` if-chain | Move to `parts/*.tsx`; `renderPart` → type→component map. File drops to ~600 (0 net lines, but each part becomes touchable) |
| **src-tauri/src/voice.rs** | 1,612 | TTS (kokoro) + STT (CLI/whisper-server/whisper-rs) + GPU DLL glue + installer + piper migration shim in one file | Split STT server backend (~170), install commands, TTS engine into 3 modules; delete dead parts (§3) |
| **src/lib/i18n.ts** | 1,618 | **~295 of 461 keys per language are never referenced** (885 dead lines, ~60% of the file). Whole dead sections: `onboarding.*` (39×3 — Onboarding.tsx uses onboardingText.ts instead), `plugins.*` (49×3), `info.*` (24×3), `terminal.*`, `update.*`, `common.*` (30×3), `sidebar.workspace.*`, most of `chat.*` — 8 dialog components contain zero `t()` calls | Prune dead keys from en/fr/es (1618 → ~670) **or** wire the 8 unwired components. Pruning is the lazy correct one |
| **src/components/GitPanel.tsx** | 1,375 | 117-line AI commit-message generator (temp session + 60 s polling loop) inlined, plus duplicated row/conflictRow frames | `genMessage` → `lib/commitGen.ts` (~120), one `FileRow` (~40), settings plumbing fix (~25) |
| **src/components/Composer.tsx** | 1,275 | **41 props**; embedded: draft overlay, local find, undo history, model-menu state, wheel-chips ×2, slash autocomplete, type-to-focus, lightbox | Menus own their state (−11 props), shared `<FindBar>`/`<Lightbox>`, drop shadow `recent` state |
| **src-tauri/src/git.rs** | 1,220 | 14 dead branch/stash/rebase/reset commands (~190 lines, see §3) | Delete; AGENTS.md git-surface list shrinks to match |

---

## 3. Dead code — delete list (all verified: zero frontend callers)

**Rust — 16 registered commands never invoked (~280 lines):**
`git_root`, `git_clean`, `git_branches`, `git_branch_create`, `git_checkout`, `git_branch_rename`, `git_branch_delete`, `git_remotes`, `git_stash_list`, `git_stash_apply`, `git_stash_drop`, `git_stash_clear`, `git_rebase_skip`, `git_reset` (git.rs, ~190 lines total), `file_reveal` (lib.rs:769), `tts_stream` (voice.rs:1543–1612, 70 L). Plus their invoke_handler entries.

**Rust — dead/duplicated helpers:**
- `f32_to_wav` vs `pcm_f32_to_wav_bytes` — **byte-identical** WAV encoders in the same file (voice.rs:1264 vs 454) → delete one
- `kokoro_voice_label` (voice.rs:1026, `#[allow(dead_code)]`), `which_bin` (platform.rs:215, dead-code allowed)
- whisper-rs in-process path is unreachable in **every shipped build** — `whisper` cargo feature is never enabled by any script; ~55 lines + the dep still sits in Cargo.lock → delete or gate the dep out of lock
- Piper migration shim (`map_piper_to_kokoro`) still applied to every call; `piper_dir` only used by removal
- update.rs relaunch fallback is 4 tiers for one failure mode — batch covers it; cut the 2 PowerShell tiers (~55 L)
- `update_stage_local` (debug-only hand-pick zip) registered unconditionally → `#[cfg(debug_assertions)]` (~65 L out of release)

**TypeScript (all grep-verified, zero callers):**
- InfoDialog.tsx:154–169 (`Groups`), 273–308 (`useEqualPills`/`EqualWrap`) — dead legacy kept alive by own `void` markers (~50 L)
- Dead CSS: `.hk-pill` + `.cmd-row.hk-row` family (dialog.css:161–435, ~60 L), `.cmd-group*` (composer.css:435–445), parked `.stage-head*` block (chat.css:97–176 + 247–254, ~86 L — hidden JSX at ChatPage.tsx:1364)
- Composer.tsx:522–530 — `oc:models` listener, **no dispatcher exists anywhere in src/**; Composer.tsx:250–254 — empty `if` block (comments only)
- Sidebar.tsx:99 — `width` prop declared+passed but never used
- Dead exports: `markExplicit` (useProviders.ts:254), `refreshSessionsFor` (useOpencode.ts:2650), `getFileError`/`getFileLoading` (useFileCache.ts:120), `invalidateTerminalProfiles` (useTerminalProfiles.ts:58)

---

## 4. Duplication (copy-paste across files)

| Pattern | Sites | Fix |
|---|---|---|
| `CREATE_NO_WINDOW` const + `creation_flags` cfg block | **17 sites across 8 files** (lib.rs, voice.rs ×5, git.rs, remote.rs ×2, terminals.rs ×2, browser.rs ×2, update.rs ×5, platform.rs ×3) | One `platform::win_command(prog)` builder (~60 L) |
| Port-probe poll loop | lib.rs:303 `wait_for_port` ≡ voice.rs:517 `wait_for_server` (remote.rs already reuses lib's) | voice.rs calls `wait_for_port` (~18 L) |
| Free-port pick | lib.rs:345, voice.rs:514, remote.rs:590 | `platform::free_port()` |
| curl download pipeline | voice.rs:216 ≡ update.rs:55 | `platform::curl_download()` (~25 L) |
| Timeout racer | api.ts:169 `withDeadline` ≡ useVoice.ts:59 `withTimeout` ≡ useSpeech.ts:188 `withSynthTimeout` | Import `withDeadline` |
| `apiErr()` + getClient deadline wrapper | useMcp.ts ≡ useProviderAuth.ts (verbatim) | `lib/apiErr.ts` |
| Permission handler | `permission.asked` (1205–1239) ≡ `permission.updated` (1241–1267) | One handler (~30 L) |
| Chip-inheritance block | duplicateSession 2397–2415 ≡ forkFrom 2443–2461 (19 identical lines) | `inheritChips()` |
| Spawn+drain+reap child process | voice.rs:846, lib.rs:385, remote.rs:645 | `run_captured(cmd, timeout)` helper (~50 L) |
| Lxss registry WSL loop | terminals.rs:322 ≡ 488 (same 20 lines twice in one fn) | Extract |
| `baseName()` | GitPanel ≡ Sidebar ≡ AgentBoard ≡ Terminal (byte-for-byte, one has a "cycle workaround" comment) | `lib/workspace.ts` (~45 L) |
| Overlay-priority Esc query (`.dlg-scrim, .drawer-scrim.open, …`) | Composer:735 ≡ SettingsDrawer:145 ≡ AgentBoard:130 ≡ Terminal:729 | `lib/focus.ts:overlayOpen()` |
| Find bar UI ×3, image lightbox ×2, resize-drag ×4, `useSpeech` two ~90% identical effects, `restoreFailedInput` re-inlined, title fallback chain ×4, whisper CLI selection block ×2 | see agent notes | Shared helpers/hooks (~150 L) |
| run.ps1 (140 L) vs run.sh (347 L) | same commands, already drifted (different sidecar fallback, different version-bump impl) | Keep **run.sh** as the single runner, delete run.ps1 (−140 L + kills drift) |

---

## 5. Unoptimized / perf

- **Polling that's already event-driven:** 2 s tick re-`opencode()`s every cycle to detect base changes (`oc:workspaces-changed` covers it) + per-tick `remoteStatus` (SSE onerror could drive it) — useOpencode.ts:1569–1601; 3 s children poll duplicates event triggers (1828–1841); GitPanel 1 s settings poll + 5 s badge re-fire of `git_watch` per repo.
- **Per-event JSON.parse:** `applyOverrides` re-parses localStorage maps on every SSE session event (see §1); `themeList` unmemoized (useSettings.ts:801); `dirKids` Map rebuilt per render (useFileCache.ts:310); `primaryLabelMap` per render (GitPanel.tsx:677).
- **Dead/listener hygiene:** listeners are all matched-clean (audited 11 hook files, zero leaks) — good.
- **MessageList:** virtualization is solid (custom 600-row window, IO lookahead, memo'd rows). Don't rewrite with react-virtual — no gain. Only the find-highlight-per-delta item above.

---

## 6. What's already good — do NOT "rework"

- **lib/ factoring:** no duplicated helpers, no dead files (all 71 imported), correct use of `structuredClone`, no fake abstractions.
- **CSS:** 0 copy-pasted declaration blocks across 8,230 lines; 23 `!important` all defensible (vendor overrides, cursor locks, reduced-motion); dead-rate ~5%.
- **themes.ts:** 984 of 1,210 lines are genuine palette data (only 59/716 vars shared with fallback — the themes are really different). It's a dataset, not boilerplate. Only trim: `cyan.dark` is a verbatim FALLBACK copy (−28 L) and accent-dim/glow are derivable via `color-mix` (−55 L, optional).
- **Voice stack:** useVoice (STT) and useSpeech (TTS) are *not* duplicates — clean internal graph, no import cycles back into chat core; separable as a unit if ever needed.
- **MessageList virtualization, Dialog.tsx shell (10+ dialogs use it), update.rs + discord.rs** — keep. update.rs is the only update path for unsigned Windows builds and has a regression test; discord.rs is fully consumed by its plugin.

---

## 7. Suggested order (biggest, safest first)

1. **Delete list §3** — pure deletion, zero behavior change: dead Rust commands + helpers, dead TSX/CSS, i18n prune. (~1,600 L, one afternoon)
2. **useOpencode surgery:** `teardownSession()` (fixes leak), `clientFor(dir)`, `onEvent` extraction, permission-handler merge. (~665 L)
3. **ChatPage → hooks:** `useVoiceRouter`, `useTwoStepConfirm`, `DialogHost`, `useChatFind`, `useDragResize`. (~800 L)
4. **Rust:** `platform::win_command` + `wait_for_port` reuse + `spawn_blocking` wraps (downloads, git, zip) + `spawn_blocking`/async for SSH-touching commands + browser.rs lock hardening.
5. **lib.rs → server.rs/input.rs/files.rs/plugins.rs** moves; voice.rs 3-way split; git.rs deletes already done in step 1.
6. **Polish:** MessageList `parts/` split, GitPanel genMessage out, shared FindBar/Lightbox, Composer props diet, run.sh consolidation, themes trim.

---

## Net

**~4,100 lines deletable** (~1,500 in frontend hooks/pages, ~600 dead Rust commands/helpers, ~885 dead i18n keys, ~250 dead CSS/TSX, ~300 duplicate helpers, ~140 scripts, ~90 themes) **+ lib.rs −1,150 by relocation**, **−1 dep possible** (whisper-rs from lock, feature never enabled), **0 unused npm deps**.
