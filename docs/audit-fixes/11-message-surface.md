# 11 — message surface: shared Lightbox + part-config context

Closes the two MessageList-related items on the "Deliberately deferred" list of
AUDIT-CHANGES.md:

- "MessageList ↔ Composer lightbox dedupe"
- "MessageList prop-drilling context"

## Scope

| File | Change |
|---|---|
| `src/components/Lightbox.tsx` | **NEW** — shared `<Lightbox src alt? onClose>`: portal to `document.body`, `.img-lightbox` scrim + centered img, window Esc listener, click-anywhere closes. Same classes/DOM as the two inline copies it replaces. |
| `src/components/MessageList.tsx` | Inline lightbox portal + its Esc effect removed → `<Lightbox src={lightbox} …>`; renders `PartCtx.Provider` (value memoized on the 4 config props); `renderPart` slimmed to `(part, key, onImage?, streaming?)`; new tiny `ReasoningPart` wrapper resolves `defaultOpen={!collapsedDefault}` from context; `LazyMsgRow` drops the 4 drilled props. |
| `src/components/ToolBlock.tsx` | Exports `PartCtx` + `PartCtxValue` (module-level context) and consumes it (`collapsedDefault`, `taskCosts`, `dir`, `onOpenSubagent`) instead of receiving them as props. |
| `src/components/parts/TaskBlocks.tsx` | `TaskResultBlock` / `TaskMixed` / `SubtaskBlock` consume `PartCtx` too (fix 3); `TaskMixed` now takes only `text`. |
| `src/components/Composer.tsx` | Inline attachment-preview portal + its Esc effect removed → `<Lightbox src={preview} …>`. |
| `src/pages/ChatPage.tsx` | **unchanged** — the 4 props (`collapsed`, `dir`, `taskCosts`, `onOpenSubagent`) are still the provider's only source, so they stay on the `MessageList` invocation; only the ChatPage → LazyMsgRow → renderPart → ToolBlock stretch was flattened (4 levels → context). |

## Changes

- **Context home:** `PartCtx` lives in `ToolBlock.tsx`, not `MessageList.tsx` —
  `MessageList` already imports `ToolBlock`, so exporting upward keeps the graph
  one-way; a context in `MessageList` would make `ToolBlock`/`TaskBlocks` import
  back into `MessageList` (import cycle).
- **`renderPart` cannot call `useContext` itself** — it runs in a per-part loop
  inside `LazyMsgRow`'s render, and streaming grows the parts array mid-render,
  which would change hook count (rules-of-hooks violation). Instead the
  components it creates are the consumers: `ToolBlock`, `TaskMixed`,
  `TaskResultBlock`, `SubtaskBlock` read `PartCtx` directly; `Reasoning` keeps
  its untouched contract behind the 4-line `ReasoningPart` wrapper.
- **Provider value is memoized** (`useMemo` on the 4 props), so per-delta
  MessageList re-renders keep the same context identity and don't fan out to
  consumers.
- **Esc/click semantics identical:** the shared listener closes on
  `Escape` keydown and on clicks to either the scrim or the img, exactly as the
  removed inline copies. The component only mounts while `src` is set, so the
  listener exists only while the lightbox is open (as before).

## Regression watchpoints

- Image zoom in chat: click a rendered image part → full-screen lightbox;
  click it / press Esc → closes and chat is interactive again.
  *Smoke: attach nothing, send a prompt that returns an image, click it, Esc.*
- Composer attachment preview: drop/pick an image attachment, click its chip
  thumbnail → same lightbox opens; Esc closes and the draft text survives.
  *Smoke: attach an image in the composer, click the chip, Esc, keep typing.*
- Subagent viewer opens from tool blocks: the ↗ button on `task` tool blocks
  and `task`-result/subtask blocks still routes to ChatPage's `openSubagent`
  (now via context).
  *Smoke: run a subagent task, click ↗ on the tool block — viewer opens.*
- Collapsed default + per-part costs: `/collapse` still flips tool/reasoning/
  task-block default open state, and `task` blocks still show their child
  session's tok/cost chip from `childTaskCosts`.
  *Smoke: toggle /collapse → blocks change default; a task block shows "N tok · $x".*
- `LazyMsgRow` is `memo()`d — context consumers nested inside a memo'd row
  still re-render on a real context change (React context bypasses memo
  bail-out); values are memoized, so this fires only on genuine value changes.
  Accepted trade-off, not a bug.

## Verification

- `npm run test` — 30/30 files pass.
- `npx tsc --noEmit` — zero errors in the touched files. (Working tree at time
  of check carries unrelated in-flight errors in `Terminal.tsx`/`useOpencode.ts`
  from a concurrent fix session; not introduced here, files outside this scope.)

## Deferred

- ChatPage → MessageList props intentionally kept: the provider needs a source,
  and ChatPage already holds all four values; removing them would mean a
  parallel store/event channel for no call-site gain.
- `Reasoning` not context-direct (wrapper instead): changing its prop contract
  would ripple for one derived boolean; revisit if `Reasoning` grows more
  part-config needs.
- While a lightbox is open, the inline `onClose` arrow re-attaches the Esc
  listener on every parent render — negligible, but a `useCallback`/stable
  setter pass would remove the churn if it ever matters.
