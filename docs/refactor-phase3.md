# Refactor Phase 3 — Extract ChatPage global listeners (optional)

Depends on nothing; smallest phase. Do last, only if Phases 1–2 land cleanly.

## Goal

`ChatPage.tsx` mixes layout with ~120 lines of window/document listeners.
Move them into one hook so the page reads as pure layout.

## New file

### `src/hooks/useGlobalShortcuts.ts` (~130 lines)

Takes `{ settings, update }` plus setters it needs to drive
(`toggleDiff`, `openSettings`, `toggleAlwaysOnTop` via update). Registers:

- link-capture → embedded browser (`oc:` browser open)
- WebView2 zoom hotkey block + context-menu suppression
- Ctrl+P always-on-top toggle
- tray visibility sound listener (`visibility://changed`)
- slash-command UI handoffs: `oc:themes` / `oc:scheme` / `oc:diff` /
  `oc:settings` / `oc:thinking`
- generic button click-tick sound

All effects move verbatim — no behavior change, same cleanup semantics.

Also moved: sidebar width/closed localStorage effects could go with a small
`useSidebarWidth` if ChatPage still feels heavy; otherwise leave inline.

## Not doing

- No event-bus abstraction over `window.dispatchEvent(new Event("oc:*"))` —
  the stringly-typed handoff is fine at this scale.

## Verification

- `npm run build`
- Manual smoke: Ctrl+P pin, /themes cycles theme, /diff toggles panel,
  tray hide/show sound, chat links open embedded browser.
