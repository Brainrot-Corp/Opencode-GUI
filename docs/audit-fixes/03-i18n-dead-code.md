# Audit fix wave 03 — i18n prune + dead TSX/CSS

## Scope

Files touched (per wave constraints — nothing else):

- `src/lib/i18n.ts` — dead-key prune (en/fr/es lockstep)
- `src/lib/i18n.test.ts` — parity assertions
- `src/components/InfoDialog.tsx` — dead legacy components
- `src/components/Sidebar.tsx` — unused `width` prop
- `src/styles/dialog.css` — dead hotkey-pill CSS
- `src/styles/composer.css` — dead `.cmd-group*` CSS
- `src/styles/chat.css` — parked `.stage-head*` CSS

## Changes

- **i18n.ts: 1618 → 935 lines** (−684). Key counts per language: **461 → 238** (−223 × 3 langs = 669 key lines + 15 en comment/blank lines). All three dicts remain parallel with identical key sets — asserted in `i18n.test.ts`.
- **Key ledger (per language, verified by scan):**
  - live (referenced somewhere in src): **159** — settings 76, titlebar 17, fileTree 17, sidebar 13, common→0-live, composer 6, git 9, chat 5, permission 4, question 6, browser 6
  - dead but **preserved** (plugin-facing surface, see below): `plugins.*` 49 + `common.*` 30 = **79**
  - dead and deleted: **223** per language
- **Deleted dead sections (en/fr/es in lockstep):** `onboarding.*` 39, `git.*` 51 (incl. commit hints/generators, diff labels), `chat.*` 36 (task/answered/code/reasoning/find/jump…), `composer.*` 31 (model/agent/variant/security/usage/attach/find/mic tips), `info.*` 24, `sidebar.*` 19 (workspace/*, session.deleteTip/attention.*/compactingTip/queuedTip/middleClickTip, serverCwd, collapsed.expand), `plugins.*`→kept, `model.*` 4, `agent.menu.*` 5, `terminal.*` 5, `fileTree.*` 4, `dialog.*` 2, `update.*` 3.
- **Preserved deliberately (documented decision):** the entire `plugins.*` (49) and `common.*` (30) sections are kept in all three dicts even though nothing in-repo references them today. They are the translation surface for third-party plugins: `createPluginT()` (i18n.ts:1598+, used by `src/lib/plugins.ts:268`) falls back to core-bundle lookups, so a plugin calling `t("common.close")` or registering namespaced keys relies on these existing. Deleting them would silently break plugin localization.
- **Live/dead methodology (rigorous, double-checked):**
  1. Throwaway node script (`scripts/tmp-i18n-*.mjs`, deleted after use) extracted all keys from the `en` dict body by regex and scanned every file under `src/` (`.ts/.tsx/.css/.html`, excluding `src/lib/i18n.ts` and `*.test.ts`) for each key as a **full string-literal token** (`"key"` / `'key'`), not a bare substring — so prefix collisions (e.g. `chat.emptyNoSession` containing `chat.empty`) cannot produce false "live" verdicts.
  2. Dynamic-usage audit: grepped all of `src/` for template-literal `t(`…`)` calls, `translate(lang,` with non-literal keys, and `createPluginT` consumers — **zero dynamic core-key construction exists**. Only `plugins.ts:268` uses `createPluginT` (plugin bundles, not core keys). A conservative bare-substring pass over every candidate dead key found hits only inside longer unrelated identifiers (`oc.git.stagedCollapsed`, `oc.update.dismissed` localStorage keys; live keys `settings.terminal.title`, `chat.emptyNoSession`) — no real usages.
  3. Pre-prune assertion: en/fr/es key sets were verified identical (script aborts otherwise); dead keys verified present in all three dicts before removal.
  4. `translate()` fallback logic (plugin bundle → namespaced plugin key → core → en → key) untouched. `oc.language` / `getLang()` / `setLang()` behavior untouched.
  5. `const bundles` is now `export const bundles` so the test can assert en/fr/es key-set identity (`bundles.en`/`.fr`/`.es` same size, mutual membership) and that every key translates in fr/es.
- **InfoDialog.tsx (−56):** deleted `Groups` + its `void Groups` marker (legacy grouped rows, superseded by vc-row cards) and `useEqualPills`/`EqualWrap` + `void EqualWrap` (equal-width pill layout, superseded by keycaps). Both were referenced only by their own `void` markers. Cleaned the defensive `closest()` at the recording-handler: `.hk-pill` selector removed (`.kc-btn` / `.kc` remain — both live). Dropped now-unused `useLayoutEffect`/`useRef` imports.
- **Sidebar.tsx:** the `width: number` prop (declared at old line 99, never used inside the component) was **attempted to be removed**, but `tsc --noEmit` then fails at `ChatPage.tsx:1323` (excess JSX prop), and ChatPage.tsx is off-limits this wave → prop kept as **`width?: number`** with a comment marking it legacy. See Deferred.
- **dialog.css (−52):** deleted `.cmd-row.hk-row`, the `.hk-pill` family (base/hover/fixed/rec/off), `.cmd-row.hk-row.conflict .hk-pill`, `.cmd-row.hk-row.static`, `.hk-desc`, and the `.cmd-group--pills` block — the replaced hotkey-pill UI; no TSX renders these classes (only the dead InfoDialog blocks did). **Kept** `@keyframes hk-rec` — still used by live `.kc-btn.rec`. (`.hk-sub`/`.hk-key` are also zero-referenced but were outside the audit's verified list — left in place, see Deferred.)
- **composer.css (−13):** deleted `.cmd-group` + `.cmd-group-label` (used only by the dead `Groups` component). Kept `.cmd-row`/`.cmd-name`/`.cmd-desc` — live in `CommandDialog.tsx:194`.
- **chat.css (−86):** deleted the parked `.stage-head*` block (`.stage-head`, `--action`, `--with-close`, `-wrap`, `-close`, `.stage-head span`) — the workspace banner JSX is deliberately hidden (ChatPage.tsx:1364 carries the "ponytail: hidden for now" note; only that comment still mentions the class). Zero TSX references.

## Regression watchpoints

No rendered-UI behavior change intended — dead code only. Missing-translation smoke test: set `oc.language` to `fr`, then `es`, in Settings and click through every formerly-live surface (the 159 live keys — settings drawer, file tree, titlebar, git panel, permission/question dialogs, browser bar, sidebar tabs/session menu/attention badge, composer placeholders/stop/send, chat empty/rewind/close confirms):

- Settings drawer: every section header/desc/labels still translated (settings.* is 76 keys, all live).
- Sidebar tabs, workspace headers, session context menu (rename/duplicate/pin/share/close), attention badge.
- Titlebar agents/plugins/debriefing/speech/pin/minimize/maximize/close tips.
- Git panel: noRepo, commit button labels (Staged/All/±Push/±Sync), `git.tabs.hidden` "+N non-repo hidden", `git.loading`.
- Chat: empty state (`chat.emptyNoSession` splits on "\n" — value keeps its embedded newline), rewind banner/undo, double-press close confirms.
- Permission + question dialogs (all keys live), browser bar (back/forward/reload/url placeholder/open external/return).
- Composer placeholders (needsModel/busy/idle), stop tip/armed, send tip.
- Plugin-facing: plugin-provided translations still override via `registerPluginTranslations`; `plugins.*`/`common.*` lookups through `createPluginT` unchanged.

## Verification

- `npx tsc --noEmit` — **clean**.
- `npm run test` — **all 30 test files pass**, incl. `i18n: 21 checks passed` (was 12; +6 parity checks, +3 lang-fallback checks).
- Pre-prune script asserted en/fr/es key sets identical (461 each) and post-prune parity re-asserted in the committed test (238/238/238).
- Greps confirm zero remaining references to `hk-pill`, `hk-row`, `hk-desc`, `cmd-group*`, `stage-head` in `src/`.

## Deferred

- **Composer.tsx:522–530** dead `oc:models` listener + **250–254** empty `if` block — **deferred by constraint** (Composer.tsx owned by another agent; no `oc:models` dispatcher exists anywhere in src/, listener is provably dead).
- **ChatPage.tsx:1323** still passes `width={...}` to `<Sidebar>` — the ChatPage owner must drop that prop, and then `width?: number` (with its comment) can be removed from `Sidebar.tsx`. Prop is unused at runtime; kept only so tsc passes without touching ChatPage.
- **ChatPage.tsx:1364** stale `ponytail: stage-head` comment (the JSX block is already gone) — ChatPage owner drops it later; CSS is already deleted.
- **`.hk-sub` / `.hk-key`** in dialog.css are also zero-referenced but were outside this wave's verified delete list — candidates for a later sweep.
- If any component later gets i18n-wired (e.g. InfoDialog's hardcoded English), the deleted keys (`info.*`, `model.*`, `agent.menu.*`, `dialog.*`, `onboarding.*`, `terminal.*`, `update.*`) must be re-added to **all three dicts in lockstep** and the parity test updated.
