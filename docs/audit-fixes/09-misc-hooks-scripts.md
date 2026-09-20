# Audit fix batch 09 — misc hooks, scripts, docs (§1/§3/§4/§6 sweep)

## Scope

`src/hooks/useSpeech.ts`, `src/hooks/useVoice.ts`, `src/hooks/useMcp.ts`,
`src/hooks/useProviderAuth.ts`, `src/hooks/useSettings.ts`, `src/main.tsx`,
`src/lib/themes.ts`, `src/lib/speechText.ts`, `scripts/run.sh` (+ `scripts/run.ps1`
deleted), `README.md`, `AGENTS.md`; new `src/lib/apiErr.ts` + `src/lib/voiceEvents.ts`.
Docs only: `src/lib/i18n.ts` untouched (live keys are in use — see Deferred).

## Changes

1. **NUL byte (AUDIT §1):** `useSpeech.ts` `collectorSig` initial value contained a
   literal `\x00` (made grep treat the file as binary). Replaced with the plain
   sentinel `"init"` — it is a memoization signature compared against
   `"<count>:<msgId>:<partsLen>"`, never TTS text, so no byte-preserving escape needed.
2. **useSpeech completion effects merged (§4):** the two ~90% identical effects
   (backward scan → seenLive gate → wasStreamed tail-trim → wordCount>30 summarize /
   splitForSpeech) are now one `speakCompleted(msg)` helper plus a single effect that
   scans once for both the tail assistant (streaming → `seenLive` watch) and the most
   recently completed assistant (mid-turn fallback). Original gate ordering preserved:
   streaming watch happens before the settings gate; the mid-turn fallback keeps its
   `ttsHushed` gate (tail path deliberately consumes even while hushed, as before).
3. **Voice-locale mapping deduped (§4):** `voiceLang(voiceId)` in `lib/speechText.ts`
   replaces the two identical locale→langHint chains in `summarizeWithCommitModel` and
   the debrief handler. Same strings, same fallbacks.
4. **useSpeech localStorage reads (§1/§4):** `summarizeWithCommitModel` and the debrief
   flow now read `secondaryModel` through the `settingsNow` ref (live settings prop) —
   the direct `JSON.parse(localStorage.oc.settings)` reads are gone. `AppSettings`
   carries `secondaryModel` (validated in `useSettings`), so this is the same data with
   validation.
5. **Timeout racers (§4):** `useVoice.withTimeout` and `useSpeech.withSynthTimeout`
   deleted; both now import `withDeadline` from `api.ts`. Same timeout values (STT:
   5s/8s/14s/32s unchanged; TTS synth: 30s), same reject-on-timeout + abort-signal
   semantics. STT timeout log text changes from `"X timeout after Nms"` to
   `"X timed out"`; TTS text is byte-identical (`"TTS synth timed out"`).
6. **`MODE_FOR`/`THRESH_FOR`** (`useVoice.ts`): `export` dropped — internal only.
7. **`lib/voiceEvents.ts`:** `TTS_STOP = "oc:tts-stop"`, `TTS_LIVE = "oc:tts-live"`
   shared between `useVoice.ts` and `useSpeech.ts` (values unchanged; other files keep
   literals — out of scope for this batch).
8. **`lib/apiErr.ts`:** `apiErr()` + `getClientFor(dir, label)` (15s-deadline
   `opencodeFor` wrapper) shared by `useMcp.ts` and `useProviderAuth.ts`, which were
   verbatim copies. Labels preserved per hook ("mcp workspace" / "provider auth").
9. **`useSettings.ts`:** `themeList` is now `useMemo`'d off `themes` (was rebuilt every
   render).
10. **`main.tsx`:** the hand-rolled mac-platform regex is replaced by
    `platform.ts:isMac()` (identical implementation, single source).
11. **`themes.ts` trim (§6):** `cyan.dark` palette was a verbatim FALLBACK copy →
    collapsed to `vars: {}` (normalizeMode merges FALLBACK). Verified with a node
    script that the normalized values match the previous ones exactly for both modes,
    using the documented equivalence `rgba(accent-rgb, a) ≡ color-mix(in srgb,
    var(--accent) a·100%, transparent)`. **Accent-dim/glow were NOT converted to the
    fixed 13%/35% color-mix form:** per-palette alphas actually vary (dim 0.12/0.13/
    0.14/0.15, glow 0.30/0.32/0.34 across the 14 themes × 2 modes — verified by script),
    so a fixed mix would change rendered output beyond the tolerance the audit allowed.
    Hardcoded lines kept.
12. **`run.ps1` deleted (§4):** `run.sh` is the single runner. Ported the one Windows
    nicety run.sh lacked: `zip_dir()` helper — prefers `zip`, falls back to PowerShell
    `Compress-Archive` (Git Bash has no zip) when zipping the portable Windows
    archive. run.sh already superseded run.ps1's sidecar fallback (sst/opencode) and
    version-bump (node-based package-lock edit) — no port needed. `README.md` Dev
    section and the `AGENTS.md` Commands block now document only `run.sh`.
    `gen-icon.mjs` / `roblox-mcp-safe.bat` untouched.
13. **`AGENTS.md` reality pass:** git.rs surface list trimmed to the live commands
    (branch/stash-list/reset commands deleted; stash is push/pop only); whisper-rs
    mention removed (no longer in Cargo.toml); run.ps1 references removed; Backend
    module-split description now covers the server/input/files/windowctl/plugins
    module split without line counts that could go stale.

## Regression watchpoints

- **TTS speech of completed replies:** one shared `speakCompleted` — smoke: turn on
  speakReplies, short reply (<30 words) must speak split chunks; long reply (>30
  words) must speak the secondary-model summary (falls back to raw when no secondary
  model). Stop-speech mid-reply mutes the rest; the next turn revives speech.
- **TTS streaming partials:** stream a long reply — complete sentences/clauses should
  speak as they stream, and on completion only the unspoken tail should be spoken
  (never the whole reply repeated). Also: an older answer completing while the next
  one streams (mid-turn) must still be spoken — that path is what the merged fallback
  preserves.
- **STT mic flows + watchdog:** tap mic → speak → final transcript inserts; partials
  stream while speaking. Watchdog paths (suspended context, dead tracks, worklet
  stall) should still recover or surface "tap mic to restart". Timeouts now come from
  `withDeadline` — error text differs slightly in the STT debug log only.
- **Theme switching (incl. accent glow):** cycle a few of the 14 themes × dark/light —
  cyan.dark now inherits FALLBACK (was inline-identical); accent-dim/glow stay
  hardcoded per palette (0.12–0.15 / 0.30–0.34 alphas), so hover tint + glow shadows
  must render exactly as before in every palette × 2 modes.
- **Settings theme list:** open Settings › Appearance — theme picker list renders the
  same metas (now memoized); switching themes still applies immediately.
- **MCP dialog errors:** MCP dialog with a dead/unreachable workspace must show the
  deadline error instead of hanging; a rejected toggle must surface the server's
  `.error` message (shared `apiErr`).
- **Provider connect dialog errors:** /connect with a dead server → 15s deadline
  error; a rejected auth/oauth call must show the server's `.error` message.
- **run.sh on Windows (Git Bash):** `bash scripts/run.sh dev` (sidecar check + Vite +
  Tauri window), `bash scripts/run.sh check` (tests + tsc + vite + cargo check),
  `bash scripts/run.sh build win11` (glass MSI; win10 variant uses `--features
  noglass`), `bash scripts/run.sh portable win11` (zip via PowerShell fallback when
  `zip` is absent), `bash scripts/run.sh clean`. `setup` also installs rustup via
  winget/rustup-init when cargo is missing.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run test` — all 30 test files pass (themes: 18 checks, speechText: 50 checks —
  both watch files green).
- One-shot node script (temp): normalized cyan (dark+light) from the collapsed
  `cyan.dark` matches pre-trim values exactly under the color-mix↔rgba equivalence;
  alpha distribution across all 28 palette-modes confirms dim/glow are NOT uniform
  13%/35%, so hardcoded lines were kept.
- `rg "run\.ps1"` over README/AGENTS/scripts — zero references; `scripts/run.ps1`
  deleted.

## Deferred

- **i18n dead-key prune** (AUDIT §2, ~885 dead lines): not attempted here — the task
  default is don't-touch, and the pruning call needs a fresh key-usage grep against
  whatever state the dialog/component batches leave the tree in; they should own it.
- **Other `oc:tts-*` literal sites** (`speechText.ts`, `useVoiceRouter.ts`,
  `Titlebar.tsx`, `VoicesDialog.tsx`, `useVoiceInstall.ts`) still use string literals;
  importing the shared constants there belongs to the files' own owners.
- **accent-dim/glow color-mix collapse in themes.ts** — only safe with per-palette
  alphas, which saves nothing; revisit only if palettes are regenerated as a dataset.
- `scripts/src-tauri/` stray directory exists next to run.sh — not referenced by
  anything audited; left for the owner of that history.
