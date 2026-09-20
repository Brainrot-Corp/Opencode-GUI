# 14 — useOpencode split (wave 4)

## Scope

Wave 3 left `useOpencode.ts` at 2,400 lines (2,654 pre-audit; wave-1's 04 pulled it
down and landed `teardownSession`/`clientFor`/`handlePermAsk`/`inheritChips` +
the SSE dispatch in `lib/opencodeEvents.ts`). This wave extracts the remaining
audited clusters from AUDIT.md §2, re-located by name (the line numbers in the
original audit predate waves 1–3):

| # | Cluster | Target | Status |
|---|---|---|---|
| 1 | Ask plumbing (refs, attention, badges, peek/subscribe, ask lifecycle, responders) | `src/hooks/useAsks.ts` | **Landed** |
| 2 | Security mode (state, restore, auto-pin, auto-responder sweep wiring, cross-window sync) | `src/hooks/useSecurity.ts` | **Landed** |
| 3 | Per-session agent memory + picker | `src/hooks/useAgents.ts` | **Landed** (+ shared pin primitive with useProviders) |
| 4 | Multi-workspace session listing (dir map, getAllDirs, refresh/guardedRefresh) | `src/hooks/useWorkspaceSessions.ts` | **Landed** |
| 5 | Children/cost/usage polling | `src/hooks/useSessionUsage.ts` | **Landed** |
| 6 | Pinned/title overrides + applyOverrides | `src/lib/sessionMeta.ts` + `sessionMeta.test.ts` | **Landed** |

Allowed-file constraint honored: only `useOpencode.ts`, `useProviders.ts`,
`opencodeEvents.ts` modified; the six new modules created. ChatPage/api.ts untouched
(not needed — the hook's public return object is key-for-key identical).

**Extractions 1+2 were wired in a single pass** (the ask auto-responder sweep
effect needs both hooks) and gated together; every other cluster was gated
individually. All gates green at every step.

## Changes

Line counts (physical lines, `Get-Content | .Count`):

| File | Before | After |
|---|---|---|
| src/hooks/useOpencode.ts | 2400 | **1446** |
| src/hooks/useProviders.ts | 639 | 622 |
| src/lib/opencodeEvents.ts | 321 | 266 |
| src/hooks/useAsks.ts | — | 454 (new) |
| src/hooks/useSecurity.ts | — | 220 (new) |
| src/hooks/useAgents.ts | — | 302 (new) |
| src/hooks/useWorkspaceSessions.ts | — | 242 (new) |
| src/hooks/useSessionUsage.ts | — | 140 (new) |
| src/lib/sessionMeta.ts | — | 100 (new) |
| src/lib/sessionMeta.test.ts | — | 101 (new) |
| **Σ modified + new source** | **3360** | **3792** (+432 — split overhead: per-module headers, dep plumbing, destructure wiring; the god-hook itself shrinks 2400 → 1446) |

Composition (no circular imports — children never import useOpencode):

```ts
prov = useProviders(activeId)          // unchanged
sec  = useSecurity({ activeRef, activeId })                    // owns mode + pins
asks = useAsks({ activeRef, sessionDirRef, clientFor, getSecurityModeFor })
agentMem = useAgents({ agents, activeRef, activeId })          // registry list stays local
wss  = useWorkspaceSessions({ sessionDirRef, activeRef, LAST_KEY, clientFor, store,
                              trackerRef, setActiveId, setSessions, setMsgs,
                              markCompacting, askRefs })
usage = useSessionUsage({ activeId, busyIds, msgs, store, sessionDirRef,
                         childParentRef, syncTopBadge, clientFor })
```

Per extraction:

1. **useAsks (480 L moved, 454 L file)** — ctx surface: 4 deps. Owns the
   per-session `questionsRef`/`permissionsRef` maps, pending popups
   (`question`/`permission` state), the sidebar-attention map
   (`attentionKinds`/`attentionIds`), child→parent lineage
   (`childParentRef`, `topOfSession`, `isDescendantOf`, `syncTopBadge`,
   `resolveParent`, `forgetLineage`), ask listeners
   (`emit*/subscribe*/peek*`), the ask lifecycle handlers
   (`handlePermAsk`, `autoRespondPermission`, `respondToPermission[For]`,
   `answerQuestion[For]`, `rejectQuestion[For]`) plus teardown hooks
   (`clearAskState` for the teardown ritual, `clearSessionAsks` for abort,
   `clearPopups` for view resets). `opencodeEvents.ts` now mutates ask state
   only through the ctx: `permissionsRef`/`questionsRef` removed from the ctx
   type and replaced by `handleQuestionAsk` / `clearPermissionAsk` /
   `clearQuestionAsk` (ctx surface: 29 → 30 members).
2. **useSecurity (215 L moved, 220 L file)** — ctx surface: 2 deps. Owns the
   per-window global mode (`windowKey("oc.securityMode")`), per-session pins
   (`oc.sessionSecurityMode`), restore (boot / session-switch /
   workspace-switch), the auto-pin watcher, and cross-window storage sync.
   The former combined agent+security `oc:workspaces-changed` listener was
   split: each hook registers its own listener for its half (same event, no
   interaction between the halves).
3. **sessionMeta (36 L moved, 100 L file + 97 L test)** — pure localStorage
   accessors: `getPinned`/`getTitleOverrides`/`togglePinned`/
   `writeTitleOverride`/`isPinned`/`applyOverrides` with the module-level
   caches moved with them; the hook only wires the storage-event cache
   invalidation. Also hosts the shared per-session pin reducer `pinEntry`
   (see 3).
4. **useAgents (265 L moved, 302 L file)** — ctx surface: 3 deps. Owns
   `agentSel`, the `oc.sessionAgents` pin map, the `oc.disabledAgents`
   override, the boot/session-switch/workspace-switch restore chain, the
   auto-pin watcher, registry pruning, and `selectAgent`/`cycleAgent`/
   `toggleDisabledAgent`. **Shared primitive:** the session-pin reducer
   (`rememberSession` in useProviders ≡ `rememberAgentSession` here) was
   lifted to `sessionMeta.ts:pinEntry` and adopted by `useProviders`
   (`rememberSession`, `rememberVariantSession`) — identical shapes, low-risk,
   covered by the new test.
5. **useWorkspaceSessions (178 L moved, 242 L file)** — ctx surface: 11 deps.
   Owns `getAllDirs` (workspace dedupe incl. the `""`/server-cwd slot),
   `getDirForSession`, `refreshSessionsFor` (the dead audit export — now
   private), `refreshSessions` (workspace-close cleanup, pending-creation
   preservation, stale-attention pruning), TF-04 `guardedRefresh`
   serialization, the live `oc:workspaces-changed` re-listing listener, and
   the `debugSessions` filler map (`addDebugSession`/`dropDebugSession`).
6. **useSessionUsage (100 L moved, 140 L file)** — ctx surface: 8 deps. Owns
   `activeChildren`, the event-driven children refresh
   (`refreshActiveChildren`/`refreshChildrenRef` — task-completion events +
   busy→idle settle edge; the 3 s poll was already gone in wave 3), and the
   derived `sessionUsage`/`childTaskCosts` totals. `msgs` is passed only as
   the recompute trigger (deps preserved: `[msgs, activeId, activeChildren]`).

Remaining in useOpencode (thin wiring + the clusters outside wave 4's
mandate): view state, session store + busy tracker, SSE boot/reconcile effect
(+ boot ask recovery), prompt/queue core, submit/slash/undo, revert/fork/
duplicate/clear/remove/rename, and the return object (key-for-key identical
to the pre-split shape).

## Regression watchpoints

- **Permission approve/deny UI** — popup still resurfaces on session switch
  (`openSession` → asks popups) and `respondToPermission[For]` still clears
  the map entry + badge before POSTing. Smoke: trigger a permission ask →
  bar appears → Always → bar closes, no re-ask; reject → task stops.
- **Question dialogs + peek** — `handleQuestionAsk` (via ctx) stores + badges
  + emits; `peekQuestion`/`subscribeQuestion` still feed the subagent viewer.
  Smoke: a subagent question → badge on the visible parent, answer from the
  subagent viewer stays in its history.
- **Security mode restore / auto-pin / auto-responder / cross-window sync** —
  child owns the same restore chain (pin → workspace memory → window global)
  and the same `restricted`→`block` migration. Smoke: switch workspace → mode
  restores; change mode → auto-pins per session; two windows → storage sync.
- **Per-session agent defaults** — restore on session switch still outranks
  workspace memory which outranks the window global; vanished agents are
  pruned (now also from `LAST_AGENT_KEY` — moved verbatim). Smoke: pick agent
  B in one session, switch away and back → B restored.
- **Session listing across workspaces + clear-sessions flows** —
  `refreshSessions` still drops file caches for closed workspaces, preserves
  pending creations, re-adds debug fillers, and clears the stale active view.
  Smoke: add/remove a workspace → list rebuilds; sidebar "clear" → all
  sessions deleted, view resets.
- **Children/task badges + costs** — children refresh still fires on
  task-completion events, on `session.created/updated` with a parent, and on
  the busy→idle settle edge; totals still add child cost/tokens. Smoke: run a
  subagent task → footer cost + per-task chip update without a poll.
- **Pinned titles / renames** — `togglePin`/`isPinned`/`renameSession`
  fallback now go through `sessionMeta.ts` (same keys, same cache semantics,
  same storage-event invalidation). Smoke: pin a session → stays on top after
  refresh; rename offline → local override applies.

## Verification

- `npx tsc --noEmit` — clean after every extraction (final: clean).
- `npm run test` — **31/31** test files pass (baseline 30/30 +
  `sessionMeta.test.ts`, 17 checks).
- `npx vite build` — clean (import-graph sanity beyond tsc).
- Not run (needs a live sidecar + UI): the smoke tests above.

## Deferred

- `useOpencode.ts` is at 1,446 lines — above the ~800 budget. The six audited
  clusters are exhausted; the remaining mass is SSE boot/reconcile wiring
  (~330 L incl. the boot-time ask recovery), the prompt/queue/submit core
  (~300 L), and the fork/duplicate/revert/clear flows. Extracting those needs
  new child modules (a boot/transport hook, a prompt core hook) that are not
  in this wave's authorized file list — next wave item, along with the
  `getPinned`-on-`sessionPin` naming detail in `sessionMeta.ts`.
- `useAsks`/`useSecurity`'s mutual dependency is one-directional
  (asks ← security mode via dep); a future `oc.security*` lib module could
  own the type if hooks stop sharing it.
