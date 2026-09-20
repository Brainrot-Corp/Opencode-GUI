# 10 — Panels + shared hooks: deferred fixes (wave 10)

## Scope

Only these files were touched (per task constraints):

- `src/hooks/useDragResize.ts` — extended, backward-compatible
- `src/hooks/useTwoStepConfirm.ts` — extended, backward-compatible
- `src/components/GitPanel.tsx` — hook adoptions
- `src/components/Terminal.tsx` — hook adoption (dock drag only)
- `src/components/AgentBoard.tsx` — Simulate mode deleted
- `src/styles/agent-board.css` — orphaned sim button styles removed

No other files touched. Existing call sites kept byte-identical:
`ChatPage.tsx` (`useDragResize` sidebar, `useTwoStepConfirm` ×2),
`SettingsDrawer.tsx` (`useTwoStepConfirm(4000)` ×2), `FileEditor.tsx`
(`useTwoStepConfirm(3000)`) — new options are opt-in with defaults
reproducing today's behavior exactly.

## Changes

### 1. `useDragResize` — orientation/invert extension

Hook was width-only (`clientX + dx`). Added opt-in options, all defaulting to
the original behavior:

- `orientation?: "width" | "height"` (default `"width"`) — drags track
  `clientY` when `"height"`
- `invert?: boolean` (default `false`) — delta subtracted (`startW - dx`),
  i.e. drag up/left grows the panel
- `bodyClass?: string` (default `"resizing"`) — body class during drag
  (git.css owns a `body.gp-resizing` row-resize cursor rule)
- `cursor?: string` — inline `document.body.style.cursor` override set
  during drag and cleared on mouseup/blur (`body.resizing` CSS forces
  col-resize, so vertical drags need `row-resize`)
- `clamp?: (v: number) => number` — final shaping pass (flooring) applied to
  every value, preserving the exact `clampH` results of the old local drags

**GitPanel.tsx** — replaced its local height drag (`clampH` + raw-mousemove
block) with:

```ts
useDragResize({ min: GH_MIN, max: Math.floor(window.innerHeight * 0.6),
  initial: () => clampH(Number(localStorage.getItem(GH_KEY())) || GH_DEFAULT),
  onTick: () => playSound("resize"),
  orientation: "height", invert: true, bodyClass: "gp-resizing", clamp: clampH })
```

Bounds (`GH_MIN`…`floor(0.6·innerHeight)`), flooring, `oc.git.h` persistence
effect, `gp-resizing` body class, `git-panel.dragging` class (from the hook's
`resizing`), 70 ms tick-throttled `resize` sound and double-click reset are
all unchanged. Only difference: mid-drag updates are now rAF-coalesced (final
value identical; the old code set state on every mousemove).

**Terminal.tsx (dock drag only)** — replaced the vertical resize block with:

```ts
useDragResize({ min: H_MIN, max: Math.floor(window.innerHeight * 0.7),
  initial: () => clampH(Number(localStorage.getItem(H_KEY())) || 240),
  onTick: () => playSound("resize"),
  orientation: "height", invert: true, cursor: "row-resize", clamp: clampH })
```

Same rAF coalescing as before, same `body.resizing` class, `row-resize`
cursor override preserved, `oc.term.h` persistence unchanged. `dragging` is
now `sideDragging || dockResizing` so `.term-dock.dragging` (visual freeze)
still applies during both the vertical and side drags.

**Terminal.tsx side-panel drag — NOT adopted (documented skip).** It is an
inverted width (`startW + (startX - clientX)`), which the extended hook now
expresses, but it also owns side-channels the hook can't carry: the
`__termSideResizing` body flag consumed elsewhere (xterm blur/fit suspend),
its own `sideResizing` state, and dual state updates. A hook adoption would
need another opt-in for an out-of-band body flag — not a clean fit; local
implementation kept.

### 2. `useTwoStepConfirm` — ttl/cancel extension

- Signature: `useTwoStepConfirm(windowMs = 1000, opts?: { ttlMs?: number | null })` —
  `ttlMs` (when provided) replaces the expiry; `null` = armed until
  `cancel()` or a confirming press, with no timer. Default (`windowMs`
  positional, no opts) is byte-identical to the old hard-expiry behavior
  (unchanged callers: ChatPage ×2 default, SettingsDrawer ×2 `4000`,
  FileEditor `3000`).
- Return now also exposes `cancel()` (disarms without confirming; `armed`
  was already returned).

**GitPanel.tsx** — `confirmPath` now runs through the hook with
`ttlMs: null` (the old string state had no expiry at all; force-push stayed
armed across more-menu reopen — now formally guaranteed). `confirmPath`
still names the target (row path / `"*"` / `"force-push"`); every existing
cancel/execute point (`rowAct`, `discardAll`, Keep ✗ buttons, force-push
exec) routes through the wrapper, which maps clear → `cancel()`, arm →
`press()`, target-switch → cancel+re-arm. Hint keys and the ✓/✗ confirm UX
are unchanged.

**Sidebar's per-dir ✓/✗ confirm — NOT this pattern** (armed state is a dir
key with distinct confirm/cancel buttons; already documented in
07-shared-adoption.md — skipped again).

### 3. AgentBoard — Simulate mode deleted (owner decision, user-approved)

Removed: `simRunning`/`nowMs`/`rafRef` state, the 60fps rAF loop effect,
`SimNode` type + `statusFor`, `simNodes` memo, `LANE_COUNT`/`LOOP_MS`
consts, `loopBaseRef`/`loopElapsed`/`progressFor`, `nodePos` memo,
`toggleSim`, the `showSim` render branch (sim lanes + `ag-arr*` SVG markers),
the Simulate/Stop toggle button, sim references in the header count and the
empty-state copy ("or click Simulate…"). `EDGES` stays (taskEdges reuses the
shape); `SimStatus` stays (task/live lanes type on it). ResizeObserver/sync
effects dropped their `simRunning` deps. `.agent-sim-btn` (all 4 rule
blocks) deleted from `agent-board.css` — no other `sim-*` classes existed.

## Regression watchpoints

- **Git panel resize:** drag the panel's top edge — grows when dragging up,
  clamps to 120 px / 60 % viewport, row-resize cursor, tick sound, height
  survives reopen (`oc.git.h`), double-click resets to 220.
- **Git force-push/discard confirm:** "Force push" arms, menu may be closed
  and reopened any time later — it must still show "Confirm
  force-with-lease?" and fire on second click; row discard ✓/✗ and Revert-all
  confirm behave as before.
- **Terminal dock resize:** drag the dock's top edge — grows upward, 160 px /
  70 % bounds, frozen visuals + row-resize cursor mid-drag, height persisted
  (`oc.term.h`), double-click resets to 240; side-panel drag unchanged.
- **Agent board:** renders real tasks/live sessions only — no Simulate
  button, no fake lanes; empty state shows "No background agents"; header
  drag + 8-handle resize still work and persist.

## Verification

- `npx tsc --noEmit` — clean (one transient error from a concurrently
  edited `useOpencode.ts` cleared on re-run; that file is not part of this
  wave).
- `npm run test` — all 30 test files passed.
- Note: dev-profile checks don't apply (frontend-only change).

## Deferred

- **Terminal side-panel drag adoption** — inverted width now expressible,
  but the `__termSideResizing` body flag / dual state side-channels don't
  map onto the hook; revisit if the hook grows an `onStart`/body-flag hook.
- **AgentBoard 8-handle `{x,y,w,h}` geom drag** — doesn't fit an edge-resize
  hook; the audit's "dup ×4" is now dup ×1 effectively (ChatPage sidebar,
  GitPanel height, Terminal dock all on the shared hook).
- **Sidebar per-dir confirm** — different arm pattern (dir-keyed ✓/✗), not a
  `useTwoStepConfirm` fit.
