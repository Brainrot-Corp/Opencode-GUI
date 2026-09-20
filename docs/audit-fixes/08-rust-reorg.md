# 08 — Rust backend reorganization (lib.rs decompose + voice.rs split + cross-file dedup)

## Scope

Wave 2 of the Rust backend reorganization (per AUDIT.md §1/§2/§3/§4). Wave 1 had already landed:
dead git commands deleted, lib.rs file commands made async + spawn_blocking, `platform::win_command()`
+ `platform::free_port()`, blocking/dead-code fixes in voice/update/browser/discord/pty/remote/terminals.

This wave:

- **lib.rs decompose** — pure relocations, no logic changes. lib.rs 2,441 → 513 lines.
- **voice.rs 3-way split** — stt.rs / tts.rs / voice_install.rs + glue voice.rs.
- **Cross-file dedup** — `win_command` adoption, `curl_download` convergence, one command-line
  tokenizer, git `run_root` boundary now spawns on the blocking pool + honors its timeout.
- Loose ends from wave 1 cleaned: `tts_stream` stub + registration deleted;
  `update_stage_local` left as-is (documented below).

## Changes

### New modules (from lib.rs)

| Module | Lines | What moved from where |
|---|---|---|
| `server.rs` | 256 | `ServerState`, Windows Job Object `pub(crate) mod job` (lib.rs re-exported it as `crate::job`; call sites now use `crate::server::job::assign`), `resolve_opencode_exe`, `wait_for_port` (now `pub(crate)` — remote.rs tunnel wait reuses it), `spawn_server`, `server_url` command |
| `files.rs` | 345 | `write_file`, `file_create/delete/rename/duplicate`, `copy_dir_recursive`, `file_open`, `workspace_is_dir` (all keep their wave-1 async + spawn_blocking shape) + the workspace/window-scope cluster: `BOOT_ID`/`boot_id`, `is_secondary`, `restore_ws_arg`, `WINDOW_WS`, `file_backed_workspace`, `WindowScope`, `window_scope`, `workspace_file`, `workspace_get/set`, `read_saved_workspace` (was task-listed "workspace.rs or files.rs") |
| `windowctl.rs` | 241 | `TRAY_RESET`, `keep_size_flag(+_present)`, `set_tray_reset`, `default_size`, `apply_default_size`, `show_main`, `hide_main` (+ `hide_main_for_close` alias for the CloseRequested guard), `toggle_main`, `hide_to_tray`, `CLOSE_ON_X`, `set_close_on_x`, `quit_app`, `toggle_window`, `window_focused`, `debug_log` + debug-only `log_dbg`, `spawn_new_instance`, `apply_jumplist` |
| `input.rs` | 692 | Windows-only cluster behind the old `#[cfg(windows)]` gates, module now declared `#[cfg(windows)]` in lib.rs: last-focused-HWND persistence (`write/read_last_focused`), `is_opencode_window`, `send_ipc_to_hwnd`, `IPC_TOGGLE/MIC/SHOW`, `ipc_hook`, `wininput`, `unpoison_input`, `webfocus`, `resize_cursor` (+ non-Windows stub stays in lib.rs), `handle_global_shortcut` (whole router incl. both hotkey halves — kept intact in one function). **Hand-rolled `b64()` deleted** → `base64::engine::general_purpose::STANDARD.encode` (dep already used by pty.rs) |
| `plugins.rs` | 263 | legacy `themes_dir`/`plugins_dir` (renamed `legacy_*`), `PluginDir` + `plugins_scan`, `http_json`, `theme_config_read/write`, `reveal_config_dir/plugins_dir`, `plugin_remove`, `plugin_install_files`, `watch_dir` + new `watch_all()` helper (watching new + legacy dirs) |
| `glass.rs` | 34 | `GLASS` static, `os_glass` command, the three `apply_glass` cfg variants |
| `voice/stt.rs` | 572 | whisper dirs (`whisper/bin/bin-gpu/models`), `find_cli*`, `VoiceStatus`/`voice_status`, `GpuStatus`/`voice_gpu`, `TranscribeOut`, `transcribe_via_cli`, `voice_transcribe`, `pcm_f32_to_wav_bytes` (moved to voice.rs glue, used by both STT + TTS), whisper-server backend (`find_server*`, `WhisperServer` + lock, `ensure_whisper_server`, `shutdown_whisper_server`), `voice_transcribe_pcm`, `run_whisper` |
| `voice/tts.rs` | 491 | kokoro dirs, GPU dll pack + `SetDllDirectory` glue, TTS debug ring (`push_tts_log` etc.), `KOKORO_VOICES` catalog, `map_piper_to_kokoro` (kept — see Deferred), `is_kokoro_voice`/`kokoro_voice_installed`, broken-q8f16 model guard, `TtsStatus`/`tts_status`, `tts_debug_log`/`tts_clear_debug`, `KOKORO` lock + `get_kokoro` + `clear_kokoro_cache`, `tts_speak`, `tts_warm`, `tts_speak_pcm`, `kokoro_remove_engine`, `tts_gpu_remove`, `tts_remove_voice` |
| `voice/voice_install.rs` | 234 | `DOWNLOAD_CAP`, `unique_temp_path`, `downloads_dir`, `part_path`, `rename_or_copy`, `voice_remove_all`, `voice_download` (now via `platform::curl_download`), `install_bin_finalize`, `install_model_finalize`, `voice_remove_model`, `voice_remove_gpu`, `install_piper_bin` (name kept — frontend `useVoiceInstall.ts` still invokes it), `install_tts_voice_part`, `install_kokoro_gpu_part` |
| `voice.rs` (glue) | 46 | module wiring + flat `pub use` of all voice commands (lib.rs imports unchanged), shared `pcm_f32_to_wav_bytes`, re-export of `unique_temp_path` |

lib.rs keeps: module declarations + command imports, `invoke_handler`, `run()` (builder, plugins,
single-instance callback, setup, tray, RunEvent handler, Exit teardown). 513 lines, under the ~900 target.

### TASK 1 notes

- `#[tauri::command]` relocations keep their exact names/args/return types; lib.rs imports them via
  `use module::{...}` exactly as before (Tauri's generated `__cmd__` macros ride along).
- Windows-specific input code stayed behind the same cfg discipline: `#[cfg(windows)] mod input;`
  in lib.rs, non-Windows `resize_cursor` stub in lib.rs, `window_focused`/`apply_jumplist` have
  `#[cfg(not(windows))]` fallbacks in windowctl.rs.
- `windowctl.rs ⇄ input.rs` cross-references (show_main → unpoison_input, ipc/hotkey →
  hide/show/window_focused) are same-crate module cycles — legal, no restructuring needed.

### TASK 2 notes

- voice.rs split into `stt.rs` + `tts.rs` + `voice_install.rs` as submodules of `voice` so the
  shared helpers (`pcm_f32_to_wav_bytes`, `unique_temp_path`, `part_path`, `rename_or_copy`,
  `DOWNLOAD_CAP`, `downloads_dir`) live in the glue/parent and submodule paths stay short.
- `tts_stream` stub **deleted** (wave-1 loose end #1) and its `invoke_handler` line removed.
- Piper shim `map_piper_to_kokoro` **kept** (conservative): frontend `useVoiceInstall.ts` uses
  `piper` as the *state name* for Kokoro (misleading but harmless), and `oc.settings.ttsVoice`
  may still hold pre-migration Piper voice ids on old installs — the shim maps those to Kokoro
  equivalents and falls back to `af_heart`. `piper_dir` cleanup stays in `voice_remove_all`.
  Marked with a `ponytail:` comment for deletion after a release cycle.

### TASK 3 — dedup

| Item | Where | Result |
|---|---|---|
| `platform::win_command()` adoption | voice/stt.rs (`voice_gpu` powershell + nvidia-smi, `ensure_whisper_server`, `run_whisper`), update.rs (via `curl_download`; relaunch keeps its combined `CREATE_NO_WINDOW\|DETACHED\|NEW_GROUP\|BREAKAWAY` const — win_command can't express the combo), terminals.rs (`where_lookup`, `run_wsl` candidates), browser.rs (`open_external` rundll32/powershell, `open_app` where, `launch_detached`, `window_app`, test), remote.rs (`exec_remote`, `dial_blocking`) | All local `CREATE_NO_WINDOW` consts deleted except update.rs's relaunch combo. Note: `win_command` sets the flag unconditionally on Windows (also debug builds) — console-flash suppression in debug, harmless |
| `wait_for_server` → `wait_for_port` | **Skipped, deliberate** | `server::wait_for_port` validates HTTP 200 + JSON (`/health`) to beat port-steal races; STT's `wait_for_server` probes `GET /` of whisper-server and accepts *any* response byte. A whisper-server build without a web UI returns 404 → the strict check would never pass and every PCM transcribe would degrade to CLI. Both kept; 18-line overlap accepted over a GPU-path regression |
| git.rs `run_root`/`run_blocking` | git.rs:94 | `run_root` is now `async`: spawns the blocking git child via `spawn_blocking` and wraps the await in `tokio::time::timeout(timeout)` — the previously ignored `_timeout` param is now honored, so `git push/pull/fetch/sync` can't pin an async worker for NET_TIMEOUT=120s. `enrich()`'s two rev-parse/stash probes reverted to direct `run_blocking` (fail-fast, no network; runs inside git_status's existing spawn_blocking+timeout wrapper). `current_branch` became async. All ~21 async git commands `.await` |
| curl download pipeline | `platform::curl_download(url, dest, cap)` | Shared by `voice_download` and `update_download` (blocking fn, `--max-time 1800`, `--max-filesize cap`, deletes partial `dest` on failure, win_command-based). update.rs passes `u64::MAX` (no cap — sha256 gate + streaming extraction bound memory); callers keep their own cleanup (part file vs staging dir) |
| `parse_commandline` vs `parse_shell_args` | `platform::split_cmdline(s)` | One quote-aware tokenizer. terminals.rs keeps `%VAR%` `expand_env` **before** tokenizing (quirk preserved via call-site pre-expansion, no flag needed), then strips the first token as path. pty.rs `parse_shell_args` is now a thin wrapper over `split_cmdline`; its test suite passes unchanged |
| `run_captured(cmd, timeout)` | **Skipped, deliberate** | The three sites genuinely differ: `run_whisper` needs both pipes drained + partial output on failure; `spawn_server` waits on port liveness and must return the *live* child with retry loop; remote `dial_blocking` needs early-exit classification + corpse stderr drain + keeps the live child on success. Forcing one helper would add flags/callbacks — more code than saved |
| `spawn_server`/`wait_for_port` | server.rs | `wait_for_port` is `pub(crate)`; remote.rs tunnel wait now calls `crate::server::wait_for_port` |
| remote.rs port pick | `platform::free_port()` | replaces the inline `TcpListener::bind("127.0.0.1:0")` dance in `dial_blocking` |
| stt.rs port pick | `platform::free_port()` | replaces the local `free_port()` in `ensure_whisper_server` |

### Wave-1 loose ends

1. `tts_stream` — stub deleted from voice (tts) side, registration line removed from lib.rs.
   Zero references remain; handler count 111 → 110.
2. `update_stage_local` — **left as-is and documented**: debug builds have the real command,
   release builds have the Err stub with the same signature, and the unconditional
   `generate_handler![update_stage_local]` entry compiles in both. Dropping the release
   registration would need a cfg-inside-macro trick that `tauri::generate_handler!` doesn't
   support cleanly (cfg on items inside the macro list isn't allowed), so the Err stub stays.
   `SettingsDrawer.tsx` invokes it only from a debug-only path.

### Verification

- `cargo check` — clean, zero warnings.
- `cargo check --all-targets` — clean (1 dead `use super::*` in the browser test mod removed).
- `cargo test --lib` — 18/18 pass (git porcelain/NUL-rename/conflict/octal-UTF8 parsing, remote
  uri parsing/breaker/classify/argv/askpass, pty shell-arg tokenizer, browser PS invocation,
  update swap regression).
- Registration matrix: 110 `#[tauri::command]` fns, all 110 present in `generate_handler`,
  no dead entries (automated diff, `label`/`port` hits were `if let` destructuring false-positives).
- Line counts: lib.rs 2,441 → **513**; voice.rs 1,438 → **46** (+ stt 572 / tts 491 / install 234).

## Regression watchpoints (one-line smoke test each)

- **Server spawn/kill + port retry**: launch app → chat loads (sidecar on ephemeral port); hold
  a second `opencode serve --port X` before launch → retry picks a new port, error string surfaces.
- **Job-object orphan kill**: kill the GUI process from Task Manager while server runs →
  `opencode.exe` child dies within a second (KILL_ON_JOB_CLOSE).
- **All git ops**: GitPanel → stage/unstage/discard/commit/amend-all/push/pull/fetch/sync/
  diff/diff-stat/log/publish/stash-push/stash-pop/resolve/merge-abort/merge-continue/
  rebase-abort/rebase-continue → same results as before (now each op on the blocking pool).
- **Git run timeout honoring**: point a repo at a dead remote URL (or kill network mid-fetch) →
  the command returns "git fetch timed out after 120s" instead of hanging the panel forever.
- **Resize cursors**: hover/drag sidebar edge → native `.cur` from the live pointer scheme
  (no stock WebView2 bitmap); None → bundled fallback cursor still applies.
- **Global shortcuts**: Alt+Space toggles the *last-focused* instance from anywhere;
  Ctrl+Shift+M toggles mic; both skip cleanly when a combo is taken (PowerToys Run).
- **Tray**: left-click toggles; menu Show/Hide + Open new window + Quit; "Keep window size"
  ON → reopen keeps size, OFF → snap to 1100×720.
- **Jump list**: right-click pinned taskbar icon → "Open new window" + "Quit OpenCode".
- **IPC single-instance flow**: second instance with `--new-instance` opens an independent
  window; plain second launch (taskbar/pinned click) restores the first window via WM_COPYDATA
  (`IPC_SHOW`) or the single-instance callback; `--quit` arg quits the primary.
- **Unpoison/webfocus input repair**: tray-hide → re-show → mouse hover + wheel + keyboard all
  work immediately (no "repairing click"); Alt+Tab back → first keydown reaches the composer.
- **Updater staging**: `update_download(url, sha256, version)` → `update_install` → exit swap →
  relaunched as the new version with `--restore-workspace`; debug-only `update_stage_local`
  still errors cleanly in release.
- **TTS speak/warm**: Settings › Voice › "warm up" → log shows Kokoro init provider line; speak →
  WAV playback; speak_pcm → streaming PCM; GPU pack present → SetDllDirectory log line.
- **STT CLI + server paths**: transcribe a WAV (CLI path, GPU→CPU fallback notes in payload);
  PCM path → whisper-server POST (30s cap, self-kill on unresponsive) → CLI temp-WAV fallback.
- **Pty spawn/kill**: open ≤8 terminals, close → `pty://exit` emitted, reader + waiter threads end.
- **WSL distros**: terminal picker lists distro names via Lxss registry first, CLI fallbacks
  (quiet/verbose/plain) still populate, generic WSL entry when nothing parses.
- **Remote tunnels/terminals**: connect `ssh://host/path` → tunnel port, SSE flows; remote
  terminals list shows login shell + found shells; dead host fails fast (circuit breaker, 20s).

## Deferred

- **Piper migration shim** (`map_piper_to_kokoro`) kept — old installs' `oc.settings.ttsVoice`
  may still carry Piper ids; delete the shim + `piper_dir` cleanup after a full release cycle
  (marked with a `ponytail:` comment in tts.rs).
- **`update_stage_local` release registration** — kept unconditionally because the release Err
  stub has the same signature; conditional registration inside `generate_handler!` isn't clean.
- **`wait_for_server`/`wait_for_port` convergence** — skipped on strictness mismatch (see dedup table).
- **`run_captured` helper** — skipped; shapes differ too much (see dedup table).
- **git path-predicate helpers** (`path_exists`/`path_is_dir`/`remove_path`/`repo_root`) still run
  blocking inline — they're fail-fast rev-parse/`test` probes (local git is instant; remote adds
  one ConnectTimeout). The audit's high-impact fix (all `run_root` ops off async workers) is done.
- **AGENTS.md** mentions `lib.rs` watching theme/plugin dirs + "single SDK client" frontend file
  paths — lib.rs backend split should be reflected there in a separate wave (not in allowed file set).
- **whisper-rs** in-process path + dep lockout was audited earlier (feature never enabled) — not
  touched here; still deletable as its own change.
