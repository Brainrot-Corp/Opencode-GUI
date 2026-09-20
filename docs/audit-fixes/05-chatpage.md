# 05 — ChatPage.tsx extraction

## Scope

Refactor `src/pages/ChatPage.tsx` (1,567 lines) per AUDIT.md §2 ChatPage row. Constraint: only ChatPage.tsx modified; 7 new files created. Behavior-preserving; no new deps.

## Changes

- **1. Voice routing → `src/hooks/useVoiceRouter.ts` (456 L)**
  ChatPage ~398–907 (describeAct, execAct, pending yes/no refs, capture mode, transcript/partial/live handlers, routeCtx, dispatch, useVoice wiring, retranscribe seq ref, both mic hotkeys, ensureDict warmup, unmount cleanup) moved wholesale into `useVoiceRouter({ oc, settings, update, plugins, exts, themes, announce, pauseSpeech, openSettingsDrawer, closeSettings, setSbClosed })`.
  `extById` memo and vdbg/vnote/voiceLive state moved with it. Hook returns `{ voice, voiceLive, vdbg, vnote }`; ChatPage keeps the debug box / voice-note JSX and the Composer voice props. `VD_TAG` is exported from the hook, imported for the debug render. The three `eslint-disable-next-line react-hooks/exhaustive-deps` comments moved with their callbacks. execAct deps trimmed `[themes, oc.cmdList, extById]` → `[extById]` (item 8; body never read themes/cmdList; disable comment kept so lint behavior is unchanged).
- **2. Chat find → `src/hooks/useChatFind.ts` (199 L)**
  ChatPage ~1016–1207: Ctrl+F central router, find state (open/query/case/cur/hits), next/prev/F3, Esc, outside-close, `oc:find-opened` mutual exclusion, find-context tracking + hovering refs, open/close helpers. Hook takes `{ activeId, booting }`, returns state + `setChatFindHits` + stable `onFindQueryChange`/`onFindCaseToggle`/`closeChatFind`/`gotoChatFind` for MessageList props. `onFindNext/Prev` stay inline arrows in ChatPage (unchanged from before).
- **3. Plugin updates → `src/hooks/usePluginUpdates.ts` (87 L)**
  ChatPage ~583–659 + 611–628: catalog state, `refreshCatalog`, launch prefetch, `hasPluginUpdate` memo, autoUpdate flag + cross-tab storage sync, auto-install effect (`autoUpdatingRef`). Takes `plugins`; returns `{ pluginCatalog, catalogLoading, catalogError, refreshCatalog, hasPluginUpdate, autoUpdateEnabled, toggleAutoUpdate }` — same names wired to Titlebar and PluginsDialog.
- **4. Double-press confirm → `src/hooks/useTwoStepConfirm.ts` (27 L), used twice**
  ChatPage 229–270 (close session) and 272–340 (close workspace) shared the same arm/timer/hint ritual. Hook exposes `{ armed, press() }` (press returns true on the confirming second press within 1 s). Sounds stay at the call sites: arm → `playSound("click")`, confirm → session plays `"close"` before `performCloseSession()`, workspace lets `closeWorkspaceNow()` play its own sounds. Timers identical (1000 ms); `/close-workspace` event listener unchanged (`closeWorkspaceNow` untouched).
- **5. Sidebar resize → `src/hooks/useDragResize.ts` (63 L)**
  ChatPage 968–1014 (+909–917 persistence) replaced by `useDragResize({ min: 280, max: 440, initial: () => Number(localStorage.getItem(SB_W_KEY)) || 280, onTick: resizeTick })`. Hook owns rAF coalescing, `body.resizing` class, userSelect lock, blur-cleanup, `resizing` flag, and the 70 ms tick throttle; ChatPage wires the sound (`resizeTick` callback) and keeps the `localStorage` persist effect on `width`. `startResize` deps now `[width, min, max]` — same identity churn pattern as before (`[sbW]`).
- **6. Dialogs → `src/components/DialogHost.tsx` (28 L)**
  The five `oc.dialog?.kind` conditionals (help/share/variants/mcp/connect) moved into one switch that passes each dialog its exact props (`oc.cmdList`, `oc.dialog.url`, `oc.modelVariants`/`variantSel`/`setVariantSel`, `oc.closeDialog`, `refreshProviders` handoff). ChatPage renders `<DialogHost oc={oc} />` at the same tree position; no props dropped.
- **7. Presence mirror → `src/lib/presence.ts` (33 L)**
  `mirrorPresence(snap)` assigns `window.__presence` (derives `workspaceName`). ChatPage's existing effect (same deps) now calls it; field values identical, so the discord plugin contract is unchanged.
- **9. Dead JSX bits**: dropped the unused `width={sbW}` prop from `<Sidebar>` (prop is optional in Sidebar.tsx now) and deleted the stale `{/* ponytail: stage-head … */}` comment above MessageList (the JSX it referenced is absent).

Line counts: ChatPage 1,567 → 799 (−768). New files: 456 + 199 + 87 + 27 + 63 + 28 + 33 = 893 lines.

## Regression watchpoints

- **Voice describe/exec/confirm/capture flows + mic hotkeys** — say "open settings" twice: first arm/announce, second within 15 s runs; embedded command mid-sentence asks yes/no toast; "prompt" then dictation lands in composer until "send"; Ctrl+M and Ctrl+Shift+M both toggle the mic, once per press.
- **Ctrl+F in chat** — hover chat → Ctrl+F opens find bar, prefills selection; Ctrl+G/F3 next/prev loop; Shift+Ctrl+G prev; Esc closes; opening composer/file-tree find closes the chat one.
- **Plugin update auto-install** — with auto-update enabled and an outdated catalog version, launch installs without prompt; titlebar dot appears when updates exist and auto-update off.
- **Close-session double-press** — Ctrl+W on non-empty session: banner arms, second press within 1 s closes and opens neighbor session; empty session closes instantly.
- **Close-workspace double-press** — Ctrl+Shift+W in an extra workspace: banner arms, second press removes it and stays in primary; `/close-workspace` bypasses the arm.
- **Sidebar resize** — drag right edge: width clamps 280–440, resize sound ticks, persists across restart; collapse/expand buttons still work.
- **All five dialogs** — `/help`, `/share <url>`, `/variants`, `/mcp`, `/connect` each open, close via X/Esc/scrim.
- **Presence in discord** — type in composer / open diff / get a permission ask → discord rich presence reflects status.

## Verification

- `npx tsc --noEmit` → clean (exit 0) after each extraction and at the end.
- `npm run test` → all 30 test files pass, including voiceRouter (69 checks) and voiceLexicon suites.
- Baseline tsc was green before edits; no new deps added.

## Deferred

- `useTwoStepConfirm` dedup for Sidebar / SettingsDrawer / GitPanel / FileEditor (audit suggests reuse) — those files are off-limits this pass; ChatPage-local instances done.
- `useDragResize` reuse at GitPanel / Terminal / AgentBoard (dup ×4 in audit) — same off-limits reason.
- Sidebar `sidebarExtras`/`titlebarExtras`/`overlays` still inline JSX in ChatPage — would need plugin-widget memo props; untouched by design.
