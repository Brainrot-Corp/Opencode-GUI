# 07 — Shared-pattern adoption (audit §4, frontend wave 2)

## Scope

Files touched: `src/components/{Composer,Sidebar,SettingsDrawer,Terminal,AgentBoard,FileEditor,InfoDialog,VoicesDialog,PluginsDialog,SshWorkspaceDialog}.tsx`, `src/styles/dialog.css`, `src/lib/workspace.ts` (+`baseName`), `src/lib/focus.ts` (+`overlayOpen`), new `src/components/DialogTabs.tsx`.

Wave-1 shared files imported as-is, not edited: `src/hooks/useTwoStepConfirm.ts`, `src/hooks/useDragResize.ts`, `src/components/DialogHost.tsx`.

## Changes

1. **`lib/focus.ts:overlayOpen(extraSel = "")`** — the Esc/typing-priority overlay query (`.dlg-scrim, .drawer-scrim.open, .ctx-menu, .cmd-menu, .model-menu`) extracted once. Callers append site-specific extras:
   - Composer type-to-focus: `overlayOpen(", .permission-bar")` (identical set to before).
   - AgentBoard Esc: `overlayOpen()` (identical).
   - Terminal Ctrl+J reopen guard: `overlayOpen()` (identical).
2. **`lib/workspace.ts:baseName()`** — Sidebar's ssh-aware copy (`host:leaf` for `ssh://`) is the canonical one. Local copies deleted from Sidebar and AgentBoard; Terminal's `wsLabel` now calls it for the local-path branch (still routes `ssh://` through `remoteLabel`, which shows `user@host:/path` — richer than `baseName`, kept for parity with the sidebar tip).
3. **`useTwoStepConfirm` adoption** (arm/window/confirm semantics preserved, timings unchanged):
   - SettingsDrawer `confirmClean` → `cleanConfirm.press()`, 4000 ms; button visuals read `cleanConfirm.armed`.
   - SettingsDrawer `confirmThemes` → `themesConfirm.press()`, 4000 ms.
   - FileEditor `closeArmed` → `closeConfirm` (3000 ms); the armed hint now reads `closeConfirm.armed && dirty && !autosave` — same visible lifetime as the old manual state (it disarmed on clean), and the two expiry `useEffect`s are gone.
4. **`<DialogTabs>`** (new, generic over the tab-id union) replaces the 4 copy-pasted `.dlg-tabs` strips: InfoDialog (info/voice/cmds/keys), VoicesDialog (stt/tts/models/voices), PluginsDialog (installed/browse, dynamic `Installed (n)` label), SshWorkspaceDialog (auto/key/password, keeps `marginTop: 6`).
5. **Composer dead code**: `oc:models` window listener deleted (grep-verified: zero dispatchers in src/); empty `if (hasFind && !hasCode) { /* comments only */ }` block deleted (memo deps trimmed to what the body reads).
6. **Composer recent-models mirror**: local `recent` state replaced by `recentV` version counter — `allEntries` reads `getRecentModels()` fresh; `pick()` and the external-modelSel effect write storage then bump the version.
7. **dialog.css**: deleted provably dead `.hk-sub` / `.hk-key` (grep: only definition sites, no usage).

## Regression watchpoints (one-line smoke test each)

- **Esc priority across drawer/dialogs/menus**: open settings drawer → open a dialog on top → Esc closes only the dialog; Esc again closes the drawer; AgentBoard/Terminal-Ctrl+J do not react while any overlay is up.
- **Sidebar clear-sessions confirm**: trash icon arms (✓/✗ appear), ✓ within 3 s clears that workspace only, ✗ or 3 s timeout disarms, and arming a second workspace while one is armed switches targets without confirming.
- **Settings clean-themes confirm**: Reset-themes click 1 arms (warning icon + confirm label, 4 s), click 2 resets; Clean-state click 1 arms, click 2 wipes + reloads.
- **File editor close confirm**: edit a file (autosave off) → click ✕ once → "Click again to discard" + armed ✕; second ✕ closes; Ctrl+S then ✕ closes immediately with no armed hint.
- **Panel resizes**: unchanged code — terminal dock height drag, terminal side-panel width drag (inverted direction), AgentBoard header drag + 8-edge resize all behave as before.
- **Composer recent-models ordering**: pick a model → it jumps to the top of "Recent" next time the menu opens; a model changed externally (voice "use model X", session restore) also lands at top; recents cap at 5 and never leak dead provider entries.
- **Tab strips in the 4 dialogs**: Info (4 tabs), Voice & speech (4), Plugins (Installed count updates live), SSH auth (System ssh/Key file/Password) — active tab highlights, switching shows the right pane.

## Verification

- `npx tsc --noEmit` — clean except one pre-existing/in-flight error in `src/hooks/useSpeech.ts:26` (`TTS_LIVE/TTS_STOP` imported unused by a **parallel agent's** wave; file not in this task's scope).
- `npm run test` — all 30 test files pass.

## Deferred (risky adoptions skipped, per constraint)

- **SettingsDrawer:145 Esc-priority** — its selector deliberately differs (omits `.drawer-scrim.open` so the drawer never matches *itself* and could never close via Esc, and omits `.ctx-menu`); it is not expressible as base + extras. Kept inline.
- **Sidebar `clearConfirm`/`confirmWs`** — armed state is a *dir key* with separate confirm (✓) / cancel (✗) buttons and per-dir re-arm; `useTwoStepConfirm` exposes only a boolean `armed` and no reset, so cancel/switch-arm can't be expressed without editing the frozen wave-1 hook.
- **`useDragResize` in Terminal + AgentBoard** — hook is width-only (`clientX` delta, `startW + dx`); the terminal dock is *height* (inverted `clientY`), the terminal side panel is *inverted width* (drag left = wider), and AgentBoard drags an `{x,y,w,h}` geom with 8 edge handles. Any fit would change direction/bounds behavior; local implementations kept.
- **recentModels event bus** — audit claimed `recentModels.ts` "already notifies on change"; verified it does not (plain localStorage read/write). Reactivity kept inside Composer via a version counter instead of adding an event API to an out-of-scope lib file.
