# 06b — GitPanel.tsx refactor (audit §2 row + §4/§5 items)

## Scope

`src/components/GitPanel.tsx` (1,375 → 1,304 lines) + new `src/lib/commitGen.ts` (159 lines).
Net +88 across the two files: the gen core moved out but gained an explicit deps contract, the
settings poll merged into one snapshot hook, and the badge watcher set was added — the win is
GitPanel owning only wiring/state while the generator logic becomes testable lib code.
No other files touched. `useTwoStepConfirm.ts` / `useDragResize.ts` imported-or-deferred only
(see Deferred). Behavior-preserving throughout, incl. AI-commit-message generation semantics.

## Changes

1. **`genMessage` → `lib/commitGen.ts` (fix 1).** The 117-line generator
   (diff fetch → heuristic fill → temp session → 60 s polling loop → drop session) moved
   verbatim to `generateCommitMessage(deps: CommitGenDeps)`. Deps: `all/dir/files/branch`
   (button-wiring data), `client` accessor (`opencodeFor(dir)`), `secondaryModel`/`commitBody`
   getters, `cachedVariant`, announce callbacks (`onMessage`/`onError`/`setGenerating`), and the
   two abort-protocol refs (`genIdRef` token, `genSidRef` temp-session id). GitPanel keeps the
   guard wrapper (`gen || busy || !files.length` + "Nothing staged…" message) and the abort
   handle (`abortGen` — unchanged, still owns both refs). `variantFast` moved with it;
   `commitHeuristic.ts` / `commitPrompt.ts` imported, not duplicated. No `playSound` call sites
   existed inside `genMessage` — sounds stay panel-side only.
2. **Settings: one 1s tick, one parse per tick (fix 2).** No settings-changed event exists
   (verified: `useSettings` persists `oc.settings` silently and only broadcasts
   `oc:language-changed`; `oc:settings` is the open-drawer *command*, not a change channel),
   so the sanctioned fallback path was taken: `secondaryModel()` + `commitBodyEnabled()` +
   the `useCommitBody` poll merged into one `useSettingsSnap()` hook — same 1 s interval +
   `storage`/`focus` listeners, but **one `JSON.parse` per tick** feeding a memoized
   `{ secondaryModel, commitBody }` snapshot that updates state only on value change (no
   re-render churn, no per-getter/per-render re-parses; the gen-button tip alone used to parse
   twice per render). `cachedVariant` intentionally stays a **click-time** read: it reads
   `windowKey("oc.variants")`, written live by the composer's variant picker, and must not be
   ≤1 s stale.
3. **`FileRow` (fix 3).** `row()` + `conflictRow()` now build a shared module-level `FileRow`
   (identical `gp-row` / `gp-x` / `gp-file` / `gp-acts` markup and classes); letter, tip,
   disabled, `onOpen`, `confirming` and the action buttons are props (`actions` node). Keys
   (`~s`/`~w`/`~c`) moved to the usage-site elements; CSS untouched.
4. **Hint collapse (fix 6).** 6-branch IIFE → 2 real conditions: silent when `busy || gen`,
   staged non-empty, or nothing dirty; otherwise the two "No staged changes" hints split on
   `msg.trim()`.
5. **`PRIMARY_LABELS`/`PRIMARY_HINTS` (fix 7).** Module-level consts. Labels are stored as
   i18n **keys** and resolved with the hook's `t()` at render (a module-level resolved string
   would freeze the boot language); hints were already plain strings.
6. **Badge poll (fix 8).** `git_watch` now fires once per repo (first successful cycle), via a
   `watchRegistered` set: closed dirs are pruned each cycle (re-adding a workspace re-watches
   it) and a failed invoke un-registers (retried next cycle). Badge-count refresh stays on the
   5 s `git_status` cycle.

## Regression watchpoints

- **Stage/unstage:** plus/minus row buttons → `git_stage`/`git_unstage`, error strip + auto-refresh. Smoke: stage a modified file from Changes, then unstage from Staged — counts and section collapse persist.
- **Discard (row):** rotate-left → check/xmark confirm pair (untracked says "Delete file"); confirm → `git_discard`; any other row action clears the armed row. Smoke: discard an edit, delete an untracked file, cancel with the xmark.
- **Discard all:** "Revert all" → "Sure?" two-step in the Changes header → `git_discard` with staged-untracked paths included. Smoke: mixed tracked/untracked tree, cancel first, then confirm.
- **Commit flows:** Staged/All × Push/Sync via split button + menu, amend checkbox, click-time file snapshot (mid-commit files not swept), "nothing staged/all" errors preserved. Smoke: commit staged, commit all incl. untracked, commit+push with/without upstream, amend.
- **Push/Pull/Fetch/Sync/Publish/stash:** toolbar + More menu, publish-on-no-upstream, force-with-lease double-press, stash push/pop counts. Smoke: push "Publish" on a fresh branch; stash → badge ≡n → pop.
- **AI commit-message generation:** heuristic fills textarea instantly; with a secondary model: diff fetch (staged-only vs staged+unstaged for Commit All) → prompt → temp `__temp__` session → 60 s poll streams cleaned message; abort button stops the poll, aborts the session, drops it. No model → heuristic only; model not on server → heuristic + note; timeout → heuristic + "AI slow" error; commit-body toggle changes prompt + Enter-to-commit rule. Smoke: generate with free model (watch streaming fill), press the wand again mid-stream to abort, verify no `__temp__` session remains in the sidebar.
- **Conflict rows:** own section, `U` badge, ours/theirs `git_resolve` buttons (no discard arm), conflict count badge on the header + tab. Smoke: create a merge conflict, resolve via arrows.
- **Badge counts per workspace:** multi-repo tabs refresh counts every 5 s; conflicts show `{n}!`; hidden non-repo tabs note; watcher registers once (no per-cycle `git_watch`). Smoke: two workspaces, modify files in the inactive one, watch tab badge tick up without the repo list churning.

## Verification

- `npx tsc --noEmit` — clean. `npm run test` — all 30 test files pass (baseline green).
- Diff reviewed: classes, tips, error strings, keys, timings and poll intervals identical; only intended files touched (`GitPanel.tsx` + new `lib/commitGen.ts`).

## Deferred

- **Fix 4 — `useDragResize` adoption.** The wave-1 hook is horizontal-only (`clientX`-based:
  `startW + (ev.clientX - startX)`); the git panel's drag is vertical and inverted
  (`startH + (startY - ev.clientY)`), and the hook owns its own `mousemove` handler, so no
  adapter can map real window mousemove events without editing the hook. Feeding it a mirrored
  synthetic event would invert the live mousemove math. Needs an `axis: "x" | "y"` (+ sign)
  option on the hook (hook-owner change; Terminal's bottom dock drag hits the same gap).
  Local `clampH` + `startResize` kept verbatim (same 120 px / 0.6×innerHeight bounds, same
  `oc.git.h` persistence key, same `gp-resizing` body class — the hook would have renamed that
  class too).
- **Fix 5 — `useTwoStepConfirm` adoption.** GitPanel's confirm is arm → *distinct* confirm/cancel
  buttons (row check/xmark, "Sure?"/"Keep") with **no expiry**, and force-push arms across menu
  close/reopen. The hook exposes a hard 1 s expiry and **no cancel()** — a confirm-click after
  the window returns `false` and re-arms (dead click), a second `press()` after a confirm
  *re-arms* (`armRef` is zeroed), so "Keep" cannot disarm. Adopting would change discard/
  force-push timing. Needs `cancel()` + optional persistent (no-expiry) mode on the hook, then
  `confirmPath` collapses to armed + target key.
- **`wsBaseName` (fix 9)** — untouched; consolidation into `lib/workspace.ts` belongs to the
  Sidebar/workspace agent.
- **Audit §1 "pass settings down"** — preferred settings fix is out of scope here: GitPanel
  receives no settings props and ChatPage (owner of `useSettings`) is another agent's file, so
  the poll-snapshot path above was taken instead.
