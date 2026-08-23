# Refactor Phase 1 — Split `useOpencode.ts` (1026 lines)

## Goal

`src/hooks/useOpencode.ts` is a god hook holding ~7 unrelated concerns. Split it
into focused modules while **keeping the public API of `useOpencode()` byte-for-byte
identical**, so `ChatPage.tsx` and every consumer need zero changes.

## New files

### 1. `src/lib/sessionStore.ts` — pure message-store logic (~150 lines)

No React. Owns the authoritative per-session state that SSE events mutate:

- `stores`: per-session `Msg[]` maps (`storeFor`, `upsertPart`)
- `orphanParts`: parts arriving before their parent message
- `pendingDeltas`: streamed text deltas for not-yet-existing parts
  (`flushDeltas`)
- `fetchSeq`: stale-fetch guards for fast session hops
- helpers used by both the hook and event handlers: `clearSession(sid)`,
  `dropStashes(sid)`

The React hook subscribes: after any mutation it mirrors the active session's
store into `setMsgs([...store])`.

### 2. `src/lib/busyTracker.ts` — busy/settle/queue logic (~100 lines)

No React. Owns:

- `inflightRef`: live assistant messages per session
- settle timers with `SETTLE_GRACE_MS` + dedupe (`settleSession`,
  `cancelSettle`)
- outbound prompt queue per session (`pushQueued`, `clearQueued`, FIFO flush)
- busy-set add/remove helper

Callback hooks (`onSettle`) are passed in so the hook can fire sounds /
drain queues without this module knowing about React or audio.

### 3. `src/lib/slashCommands.ts` — command dispatch as data (~180 lines)

- The big `submit()` switch becomes a table of built-in commands:
  `{ name, description, takesArgs, run(ctx) }`
- `cmdList` builder moves here (built-ins first, then server registry)
- UI-only commands (`/models`, `/themes`, …) dispatch window events exactly
  as today — behavior unchanged

### 4. `src/hooks/useProviders.ts` — provider/model state (~130 lines)

Owns:

- boot-time provider fetch + capability enrichment (GET /provider hints)
- `modelSel` / `defaultModel` / `oc.lastModel` persistence
- variant map + `oc.variants` persistence, `variantSel` derivation,
  `cycleVariant`
- derived `modelVariants`, `modelCaps`

## What stays in `useOpencode.ts` (~250–300 lines)

SSE connection + event switch (thin handlers calling into sessionStore),
session CRUD (`new/open/remove/revert/unrevert`), permission/question
handling, `send`/`promptNow`, and the return object.

## Not doing

- No context/provider wrapper for the hook state — one consumer today.
- No reducer/state-machine rewrite — extraction only, logic untouched.

## Verification

- `npm run build` (tsc strict passes)
- Manual smoke: send a prompt, stream a reply, queue a second prompt,
  switch sessions mid-stream, `/help`, `/undo`.
