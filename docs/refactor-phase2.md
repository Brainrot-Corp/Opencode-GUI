# Refactor Phase 2 — Split `Composer.tsx` (541 lines)

Depends on Phase 1 (no code coupling, just sequencing).

## Goal

One component currently renders model picker, slash autocomplete, attachment
staging, keyboard routing, and usage chips. Extract the two dropdowns and the
attachment logic; keep Composer as layout + wiring.

## New files

### 1. `src/components/ModelMenu.tsx` (~120 lines)

The model picker dropdown:

- flat entry list (server default first, then providers), search-free arrow nav
- highlight scroll-into-view effect
- outside-click capture close

Props: entries, selection, highlight index, onSelect/onHighlight callbacks —
state stays owned by Composer so the shared keyboard brain keeps working.

### 2. `src/components/SlashMenu.tsx` (~80 lines)

Slash-command suggestion dropdown: filtered entries, arrow/Tab/Enter handling
is routed by Composer's key handler, menu owns rendering + scroll-into-view.

### 3. `src/hooks/useAttachments.ts` (~90 lines)

Staging pipeline: file input + drag-drop, progress states, dedupe by bytes,
capability warnings (advisory-only rule preserved), staged list + note line +
clear-on-send. Returns `{ files, note, addFiles, clearFiles, dragOver, ... }`.

## What stays in `Composer.tsx` (~250 lines)

Layout/rendering, the single global keydown router ("keyboard brain"),
usage chip, agent/variant cycling buttons, textarea.

## Not doing

- Not splitting the keyboard brain further — it is deliberately centralized;
  splitting it reintroduces the desync bugs it was built to kill.
- No new CSS files beyond moving existing class names untouched (styles stay
  in composer.css).

## Verification

- `npm run build`
- Manual smoke: open model menu (arrows/Enter/click-outside), type `/` and
  Tab-complete, attach image + duplicate, drag-drop a file, send.
