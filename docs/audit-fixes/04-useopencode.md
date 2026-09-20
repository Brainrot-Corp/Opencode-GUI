# 04 — useOpencode.ts surgery (audit §1 high-sev teardown leak, §2 onEvent extraction)

## Scope

`src/hooks/useOpencode.ts` (2,654 → 2,581 lines) per AUDIT.md §1 (teardown duplication / unbounded maps,
`applyOverrides` re-parse per SSE event, `restoreFailedInput` re-inline) and §2 (SSE `onEvent` mega-switch
extraction). Also the §3 dead exports in `useProviders.ts` / `useFileCache.ts` / `useTerminalProfiles.ts`.

Files touched: `src/hooks/useOpencode.ts`, `src/hooks/useProviders.ts`, `src/hooks/useFileCache.ts`,
`src/hooks/useTerminalProfiles.ts`, new `src/lib/opencodeEvents.ts`. `src/api.ts` NOT edited (as instructed,
`clientFor` lives inside useOpencode.ts instead of there).

## Changes

**Phase 1 — mechanical**

1. **`teardownSession(id)` helper** (useOpencode.ts:910) replacing four duplicated per-session rituals:
   - `session.deleted` SSE handler (was 1446–1477 → now a 10-line case calling `teardownSession` + active-view reset)
   - `removeSession` (was 2316–2357 → now ~25 lines: server delete + teardown + list filter + active reset)
   - `clearSessionsFor` (was 2485–2536 → loops `teardownSession` per id, bulk state wipes removed)
   - `clearSessions` (was 2539–2571 → loops `teardownSession` per id)
   The helper also prunes what all four copies missed (the unbounded-growth leak): `childParentRef` entries
   (self + children pointing at the deleted parent), `debugSessions`, `modelFallbackWarned`, `lastSentRef`.
   `clearSessions` additionally now drops `sessionDirRef` entries (missed in all previous copies).
   Note: `clearSessions` previously nuked the whole `sessionSecurity`/`sessionAgents` maps; it now deletes
   keys for the wiped ids via the shared helper — orphaned keys for unknown ids could linger, but such ids
   are unreachable in the UI and get pruned by existing boot logic.
2. **`clientFor(dir?)`** module-level helper (useOpencode.ts:47) — `(dir ? await opencodeFor(dir) : await opencode())`
   replaced at all 16 audit sites (resolveParent, autoRespondPermission, refreshSessionsFor,
   loadMessagesIntoStore, newSession, refreshActiveChildren, abort, respondToPermissionFor, revertTo,
   unrevert, promptNow (incl. the `getClient` lambda), refreshProviders + boot `loadProvidersAll`
   (the same lambdas), removeSession, renameSession, duplicateSession, forkFrom, clearSessionsFor, clearSessions).
   Only the definition site remains.
3. **Permission handlers merged** into one `handlePermAsk(ask, dirHint, sound?)` (useOpencode.ts:727), used by
   both `permission.asked`/`permission.v2.asked` (sound=true) and `permission.updated`. Each case still builds
   its own event-shaped `PermAsk` (the two payloads have genuinely different fallback chains); the shared
   handler owns the security-mode short-circuit (full → always, block → reject), map store, badge/emit,
   parent/active surfacing. Delta: the shared path now applies `updated`'s `if (!sessionID || !id) return`
   guard to `asked` too (a malformed ask with no id/sessionID could previously store a garbage Map entry —
   unrespondable either way).
4. **`inheritChips(srcId, newId)`** (useOpencode.ts:2137) — the 19-line chip-inheritance block duplicated by
   `duplicateSession` (was 2397–2415) and `forkFrom` (was 2443–2461) is now one callback used by both.
5. **`applyOverrides` caches** `oc.pinnedSessions` and `oc.sessionTitles` in refs (`pinnedCacheRef`,
   `titleOverridesCacheRef`, useOpencode.ts:832–870) instead of re-`JSON.parse`-ing localStorage on every SSE
   `session.created`/`session.updated` burst. Readers: `getPinned`/`getTitleOverrides` (now stable useCallbacks).
   Invalidated by: `togglePin` write, `renameSession` fallback write, and a `storage` listener for both keys
   (cross-window pin/rename sync keeps working). `session.created` (was 1399–1418) and `session.updated`
   (was 1419–1444) now call `applyOverrides` instead of re-implementing map+dedupe+sort inline.
6. **`session.error`** calls `restoreFailedInput(sid)` (useOpencode.ts:1692) instead of re-inlining the
   guarded draft/attachment/input restore (was 1370–1380).
7. **`renameSession` fallback** (useOpencode.ts:2104 block) reads/writes `oc.sessionTitles` through the same
   validated `getTitleOverrides()` reader (the old inline parse accepted arrays as "objects") and updates the cache.
8. **Attention state merged**: `attentionIds` Set + `attentionKinds` Record → single `attentionKinds` Record
   (useOpencode.ts:84–85); `attentionIds` is a derived `new Set(Object.keys(...))` memo, so the hook's public
   return shape is unchanged. `setAttentionFor`/`clearAttention` write one map. (Sub-nuance: changing only a
   session's kind now produces a new `attentionIds` identity where the old Set was reused — consumers read
   membership, not identity.)
9. **`_interval` smuggle removed**: the 2s workspace-tick interval is a plain `let wsInterval` in the boot
   effect closure (useOpencode.ts:1231, assigned :1373, cleared in cleanup :1474). `(esMap as any)._interval` gone.
10. **Dead exports deleted** (all re-grep-verified zero callers before deletion):
    - `markExplicit` + return entry (useProviders.ts, was :254/:631)
    - `getFileError`/`getFileLoading` (useFileCache.ts, was :120–125)
    - `invalidateTerminalProfiles` (useTerminalProfiles.ts, was :58–62)
    - `refreshSessionsFor` removed from useOpencode's returned object (was :2650); internal callers
      (`refreshSessions` fan-out) untouched — it's still in scope.

**Phase 2 — extraction**

11. **`onEvent` mega-switch → `src/lib/opencodeEvents.ts`** as `handleOpenCodeEvent(ev, ctx, dirHint?)`.
    The boot effect builds `ctx` once (useOpencode.ts:1241–1270, 29 members: store, tracker, busyRef, activeRef,
    childParentRef, sessionDirRef, permissionsRef, questionsRef, getSecurityModeFor, autoRespondPermission,
    resolveParent, restoreFailedInput, handlePermAsk, syncAttention, emitPermission, emitQuestion, syncTopBadge,
    topOfSession, setPermission, setQuestion, setSessions, markCompacting, applyOverrides, teardownSession,
    refreshSessions, refreshCommands, refreshAgents, refreshChildrenRef, learnServerDefault). Per-session SSE
    machinery (esMap, wsTicker/tick fn, boot IIFE, EventSource lifecycle) stays in the hook; `onEvent` is now a
    one-line wrapper. `prov.sentExplicitModel`+`prov.learnDefault` are encapsulated as `learnServerDefault`
    (useOpencode.ts:1115). The file-watcher throttle timestamps moved to module-level `let`s inside the lib file.
    Dispatch order/short-circuiting preserved (only the `sentExplicitModel` check evaluates after the
    role/provider checks now — pure reordering of side-effect-free guards).
12. **Title fallback chain deduped** to two tiny helpers, each preserving its site's exact operator semantics:
    `askTitle(p, extra, fallback)` in opencodeEvents.ts (permission.asked chain, `||`-based, patterns-join),
    and `bootPermTitle(pr)` in the hook's boot perm list (the two identical `??`-based chains at was
    1654–1655/1663–1664). The `permission.updated` title chain (`p.title ?? p.type ?? p.permission`) was left
    inline — it is a *different* chain (title-first, no metadata/patterns); forcing it through the shared
    helper would change outputs when `metadata` is present.

## Regression watchpoints (manual smoke tests)

- **SSE connect/reconnect per workspace** — launch, switch/add/remove a workspace folder: sessions list converges
  within the 2s tick, `live` indicator returns, dead SSH tunnel re-dials + toasts once.
- **Permission approve/deny UI** — prompt a tool-using task in "user" mode; bar pops with sound; approve once /
  always / reject all route to the right session (`respondToPermissionFor`); subagent asks badge the parent only.
- **Security auto-respond** — flip session to "block"/"full" with an ask pending: fires reject/always without UI;
  on `securityMode` change, already-stored asks auto-resolve (unchanged effect at :~760).
- **Question dialogs** — question.asked surfaces on the active session, `replied`/`rejected` clears popup + badge;
  v2 aliases behave the same.
- **Session create/delete/fork/duplicate chip inheritance** — new chat keeps last model/agent/security/variant;
  duplicate + fork inherit source chips incl. per-session variants; fork pastes the rewound text into the composer.
- **Pinned titles / pin sort** — pin toggle re-sorts via `applyOverrides`; pinned titles survive SSE
  `session.created`/`updated` bursts without flicker; another window's pin toggle propagates (storage event
  invalidates the cache).
- **Rename** — server rename emits `session.updated`; fallback path writes the validated override map and shows immediately.
- **Clear-sessions flows** — "clear workspace" wipes that workspace's sessions server-side and locally (incl.
  drafts/attachments/attention/queue); "clear all" empties the list across workspaces and resets the view.
- **Multi-window `oc:workspaces-changed`** — second window rebuilds its session list on workspace change; per-window
  security/agent/model adaptation unaffected (listeners untouched).
- **Prompt queue + abort + failure restore** — send while busy → queued chip, drains after settle; abort mid-stream
  clears busy/asks; a failing turn (or throwing prompt) restores text + attachments into the composer (shared
  `restoreFailedInput`), error bubble + toast visible.

## Verification

Baseline (before edits): `npx tsc --noEmit` → exit 0; `npm run test` → all 30 test files passed.

After **Phase 1**:
- `npx tsc --noEmit` → exit 0
- `npm run test` → all 30 test files passed (framework-free self-checks)

After **Phase 2** (same commands):
- `npx tsc --noEmit` → exit 0
- `npm run test` → all 30 test files passed

(`npm run test` output verified unchanged per file; the i18n file's check count differs from baseline because a
concurrent agent is editing i18n — unrelated to this change set.)

## Deferred

- Typing useOpencode.ts (removing line-1 `@ts-nocheck`) — explicitly deferred per task constraints; the new
  `lib/opencodeEvents.ts` is fully typed today.
- `permission.updated`'s own title chain stays inline (different fallback order — see change 12).
- `askTitle` uses `||` while the boot list used `??` — boot keeps its own `bootPermTitle` to preserve exact
  empty-string behavior; unifying them means committing to `||` semantics (arguably better, but not mechanical).
- asks → `useAsks` / security → `useSecurity` further splits (audit §2) — separate, riskier extractions.
