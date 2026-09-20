# 06 — MessageList parts split (audit §2, §4, §6)

## Scope

- `src/components/MessageList.tsx` (~1,440 lines after wave 1, actually 1,536): extract the 6 embedded sub-features, collapse `renderPart` to a type dispatch, de-drift `rowVisible`, debounce the find-highlight DOM walk.
- `src/components/ToolBlock.tsx`: dedupe the quoted-pairs regex (audit §4).
- Virtualization (sliding window, IntersectionObserver lookahead, anchor compensation) untouched per audit §6.

## Changes

| What | From | To |
|---|---|---|
| `AnsweredSummary` + its `parseAnsweredSummary` | MessageList.tsx:21–58 | `parts/AnsweredSummary.tsx` (component) + `lib/qSummary.ts` (parser) |
| `TaskResultBlock` + `TaskMixed` | MessageList.tsx:80–265 | `parts/TaskBlocks.tsx` |
| `SubtaskBlock` | MessageList.tsx:267–337 | `parts/TaskBlocks.tsx` |
| `codeText`/`codeLang`/`CodePre` | MessageList.tsx:340–436 | `parts/CodePre.tsx` |
| `mdComponents` map (unchanged content) | MessageList.tsx:438–447 | `parts/mdParts.tsx` (shared shim so parts never import back into MessageList — no cycles) |
| `Reasoning` + `STREAM_RAW_LIMIT` | MessageList.tsx:449–486 | `parts/Reasoning.tsx` |
| `TASK_RE`/`extractTaskEntries` | MessageList.tsx:63–78 | `parts/TaskBlocks.tsx` (exported; MessageList still uses `extractTaskEntries` for the `<task>` dispatch check) |
| `renderPart` if-chain (120 lines) | MessageList.tsx:516–636 | type `switch` dispatch, same null-branch behavior |
| `rowVisible`'s hand-mirrored null branches | MessageList.tsx:643–666 | new shared `partVisible(p)` — used by **both** `rowVisible` and `renderPart`'s early return, so they can't drift |
| find-highlight DOM walk | MessageList.tsx:1339–1402 | same walk, now trailing-debounced 150 ms (mirrors GitPanel `scheduleRefresh`); clear+rebuild run together in the trailing pass; next/prev/cur/wrap semantics unchanged; `oc:chat-find-clear` close path untouched |
| quoted-pairs regex (`parseAnsweredSummary` ≡ `summaryPairs`) | MessageList.tsx:21–28 ≡ ToolBlock.tsx:121–128 | one implementation in `lib/qSummary.ts` |

Note on the merged regex: the two old copies differed in their gate — MessageList required the phrase at the **start** of the text, ToolBlock matched it **anywhere** in tool output. `qSummary.ts` exports both: `parseAnsweredSummary` (prefix gate, used for synthetic text parts so a reply merely quoting the phrase stays markdown) and `summaryPairs` (includes gate, used by ToolBlock's question-tool fallback). Neither rendering behavior changed.

## Regression watchpoints

- **Answered-summary rendering**: send a prompt that triggers the question tool, answer it — the synthetic "User has answered…" text part must render as the `q-answered` card with chips, not raw text; a normal reply that merely quotes the phrase must stay markdown.
- **Task/subtask blocks**: run an agent that reports a fenced `<task>` block — collapsible task chrome with markdown body, cost chip, and the ↗ subagent button; `agent`/`subtask` parts show name + description with a collapsible prompt.
- **Code blocks w/ Monaco lazy load**: scroll a long reply with fenced code — blocks mount as `<pre>` and upgrade to Monaco within ~800 px of the viewport; copy button copies raw source.
- **Reasoning collapse**: brain icon toggles one block; `/collapse` flips defaults; streaming thinking longer than 12k chars degrades to plain `<pre class="stream-raw">` until completion.
- **Find highlight next/prev/hits**: open find (Ctrl+F), type, Enter/Shift+Enter wrap around all hits, count `n/total` updates, active hit is opaque and scroll-centered; first highlight appears ~150 ms after open/keystroke (was instant) — that delay is the intended debounce.
- **Streaming perf while find open**: stream a long reply with find open — the walk+rebuild runs once per 150 ms pause instead of per delta; closing find clears all `.find-hit` spans via `oc:chat-find-clear`.

## Verification

- `npx tsc --noEmit` — clean (SettingsDrawer errors seen mid-session were another wave's in-flight edits, resolved before final run; not this change's files).
- `npm run test` — all 30 test files pass.
- No changes to ChatPage props (MessageList's surface unchanged); no new deps; no git commit.

## Deferred

- **Third-party lightbox dedupe** (MessageList ≡ Composer img-lightbox) — per instructions.
- **`taskCosts`/`dir`/`collapsedDefault`/`onOpenSubagent` prop drilling** (ChatPage→MessageList→LazyMsgRow→renderPart→parts) — skipped: flattening via a module-level context would swap the memo'd `LazyMsgRow` props path for context reads inside `renderPart`-style call sites and touch ToolBlock's public props; not low-risk enough to bundle into a move-only refactor. Revisit if a 5th consumer appears.
- ToolBlock's private `fmtTok` copy (also exists in `parts/mdParts.tsx`) — out of scope; unify if ToolBlock is ever touched again.
