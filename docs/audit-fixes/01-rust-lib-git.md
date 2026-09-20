# Audit fixes — Rust lib.rs / git.rs / platform.rs (wave 01)

## Scope

Files touched (only these three; nothing else modified, no new deps):

- `src-tauri/src/git.rs` — dead command/helper deletions, `base_dir()` removal, `win_command` adoption
- `src-tauri/src/lib.rs` — dead command/helper deletions, 6 commands made async, `win_command`/`free_port` adoption
- `src-tauri/src/platform.rs` — `which_bin` + dead `reveal_path` deleted, `win_command` + `free_port` added, adopted internally

Line numbers below refer to the **pre-fix audited tree** (use `git diff` to verify).

## Changes

### A) Dead commands + registration entries (all grep-verified: zero callers in `src/`, `default_plugins/`, and no dynamic-invoke dispatch reaching them)

Verification performed before deletion:
- `rg` across `src/` and `default_plugins/` for each name: **zero hits**.
- Only dynamic `invoke(cmd, …)` sites are `GitPanel.tsx:579` and `GitPanel.tsx:823`; traced every argument passed to `rowAct`/`rowAct2`: `git_discard`, `git_unstage`, `git_stage`, `git_resolve` — all **kept** commands. No other dynamic dispatch exists (`invoke(\s*[a-z_]+[,)]` scan).

git.rs deletions:
- git.rs:570–576 → deleted `git_root` (unused; GitPanel gets root from `git_status.root`).
- git.rs:683–694 → deleted `git_clean` + its doc comment.
- git.rs:868 → section header `branches / remotes / stash / conflicts` → renamed `publish / stash / conflicts` (matches what remains).
- git.rs:870–965 → deleted `git_branches`, `git_branch_create`, `git_checkout`, `git_branch_rename`, `git_branch_delete`.
- git.rs:976–995 → deleted `git_remotes`.
- git.rs:997–1019 → deleted `git_stash_list` (GitPanel uses `stash_count` from `git_status`, which is computed by the kept `enrich()` helper — untouched).
- git.rs:1053–1077 → deleted `git_stash_apply`, `git_stash_drop`, `git_stash_clear`.
- git.rs:1115–1119 → deleted `git_rebase_skip`.
- git.rs:1121–1135 → deleted `git_reset` (`git_unstage`'s inline `git reset HEAD` fallback via `run_root` is untouched and still live).
- git.rs:58–75 → deleted dead structs `GitBranch`, `GitRemote`, `GitStash` (each used only by one deleted command above).
- git.rs:10–12 → header comment updated to name only the remaining surface (stash push/pop, resolve, merge-rebase).

lib.rs:
- lib.rs:20 → `use git::{…}` list trimmed to the 21 kept commands.
- lib.rs:769–777 → deleted `file_reveal`.
- platform.rs:83–123 → deleted `reveal_path` — dead-code warning confirmed it was used **only** by the deleted `file_reveal` (grep over `src-tauri/` + `src/`: zero other callers). AGENTS.md's platform.rs surface list should drop `reveal_path` in a follow-up docs pass (AGENTS.md itself is outside this wave's allowed files). `open_path` (used by `file_open`) and `reveal_dir` (used by `reveal_config_dir`/`reveal_plugins_dir`) remain.
- lib.rs:2012, 2064, 2068, 2077–2081, 2083–2089, 2095–2096 → removed `file_reveal`, `git_root`, `git_clean`, `git_branches`, `git_branch_create`, `git_checkout`, `git_branch_rename`, `git_branch_delete`, `git_remotes`, `git_stash_list`, `git_stash_apply`, `git_stash_drop`, `git_stash_clear`, `git_rebase_skip`, `git_reset` from the `invoke_handler` registration list in `run()`.

No private helper was left dead by A: `current_branch` is still used by live `git_push`/`git_publish`; all porcelain/parsing helpers are used by `git_status`/live ops.

### B) `base_dir()` deleted — routed through `platform::resolve_workdir()`

- git.rs:81–92 → deleted `fn base_dir(dir: &str)`; sole caller `repo_root` (git.rs:150) now calls `crate::platform::resolve_workdir(dir)`, which is byte-for-byte equivalent (`""` → `home_dir()`, non-dir → `home_dir()`).

### C) `which_bin` deleted

- platform.rs:214–224 → deleted `pub fn which_bin()` (`#[allow(dead_code)]`, zero callers — grep over `src-tauri/` and `src/` confirmed only its own definition).

### D) `platform::win_command` + `platform::free_port`

- platform.rs (after `curl_bin`) → added:
  - `pub fn win_command(program: &str) -> std::process::Command` — on Windows sets `CREATE_NO_WINDOW`; other OS returns a plain `Command`.
  - `pub fn free_port() -> std::io::Result<u16>` — `TcpListener::bind("127.0.0.1:0")` → local port. **Deviation from the stated `-> u16`: returns `std::io::Result<u16>`** because the only current caller's error path (`spawn_server`'s `?` → `ServerState.error`) must keep propagating bind failures; a `u16`-with-`0`-fallback would silently change that behavior.
- Adopted (3 sites in lib.rs + 1 in git.rs; voice/remote/browser/etc. keep their local consts per task constraints):
  - git.rs:107–117 (`run_blocking`) → `let mut cmd = crate::platform::win_command("git");` replaces `Command::new("git")` + the `#[cfg(windows)]` creation-flags block.
  - lib.rs:345 + 359–370 (`spawn_server`) → `crate::platform::free_port()?` replaces the inline `TcpListener` pick; command built via `win_command(&exe_path)` **in release only** (`#[cfg(debug_assertions)] let mut cmd = Command::new(...)` / `#[cfg(not(debug_assertions))] let mut cmd = win_command(...)`) so debug builds keep inheriting the dev console exactly as before; the two release stdio cfg-blocks collapse to one `#[cfg(not(debug_assertions))] stdout/stderr null`.
  - lib.rs:1131–1148 (`spawn_new_instance`) → same debug/release split with `win_command(&exe)`, creation-flags block deleted.
  - platform.rs:59–67, 84–100, 127–135 → `open_path`/`reveal_path`/`reveal_dir` Windows branches now build via `win_command("cmd"|"explorer")` (internal adoption inside platform.rs itself; external behavior identical).
- lib.rs:1,3 → removed now-unused `use std::net::TcpListener;`; `use std::process::Command` made `#[cfg(debug_assertions)]` (its only remaining call sites are inside debug cfg branches; keeps release builds warning-free).

### E) Sync UI-thread commands → async (`spawn_blocking` for ssh paths)

All six commands below: frontend invoke name/args/return unchanged (the dropped `remote: State<'_, RemoteState>` parameter is Tauri-injected, never passed from JS; state is now fetched inside the blocking closure via `app.state::<RemoteState>()`). Local-filesystem branches stay sync inline (unchanged fast path). Remote (`ssh://…`) branches moved into `tauri::async_runtime::spawn_blocking` so a slow host (10 s `ConnectTimeout`) no longer pins the UI thread. JoinError → `"<cmd> task failed: {e}"` (previously a panic inside would propagate as a command panic; now surfaces as the command's `Err` — strictly safer).

- lib.rs:594–610 `write_file` → `async fn`; remote branch (script + `exec_script`) in `spawn_blocking`; returns `Result<(), String>` (same).
- lib.rs:612–643 `file_create` → `async fn`; same treatment; `exists`-detection logic unchanged after await.
- lib.rs:645–665 `file_delete` → `async fn`; same; `missing` detection unchanged.
- lib.rs:667–696 `file_rename` → `async fn`; same; `missing`/`target-exists` detection unchanged.
- lib.rs:698–756 `file_duplicate` → `async fn`; the whole remote copy-name loop (incl. `too many copies` fallback) moved into the closure returning `Result<String, String>`; returned pseudo-path construction unchanged.
- lib.rs:806–820 `workspace_is_dir` → `async fn`; returns plain `bool` (unchanged JS contract — `src/lib/workspace.ts` does `invoke<boolean>(…).catch(() => false)`); the `State<'_, T>` param was dropped rather than returning `Result<bool>` because Tauri forbids borrowed params in async commands whose return isn't `Result`, and a `bool` return preserves the JS contract exactly; `Some(t)`-match replaced by let-else (`None` → `false`, same as before). `JoinError` → `false`.

`discord`/`pty`/`remote` blocking fixes are owned by other agents — untouched here.

### F) No abstractions beyond D's two helpers were added.

## Regression watchpoints

1. **Deleted git commands** — if anything still references them it would now fail at runtime with "unknown command". Grep showed zero frontend/plugin callers, and GitPanel's dynamic dispatch only emits kept names. Smoke: open GitPanel on a repo with changes → stage/unstage per-row buttons, discard (row confirm + discard-all), commit (subject+body, amend, no-verify), push/pull/fetch/sync, diff view, log list, stash push + stash pop from "more" menu, publish, conflict section resolve ours/theirs, merge-abort/continue and rebase-abort/continue buttons. All must still work; all use kept commands.
2. **`git_status` still counts stashes** — GitPanel's stash badge comes from `st.stash_count` (computed by kept `enrich()`), not the deleted `git_stash_list`. Smoke: create a stash → badge count appears; pop → count clears.
3. **`workspace_is_dir` async** — `src/lib/workspace.ts:110/141` expects a resolved `boolean` with `.catch(() => false)`. Still a plain bool → identical. Smoke: pick a valid workspace dir (accepts), a file (rejects), and a non-existent path (shows invalid); with an ssh:// workspace open, same three cases (remote path goes through spawn_blocking now).
4. **`write_file`/`file_create`/`file_delete`/`file_rename`/`file_duplicate` async** — FileEditor save, FileTree create/delete/rename/duplicate, useMcp settings write. Local paths: unchanged. Remote paths: same success/error strings; only failure-mode difference is a blocking-task panic now surfacing as `"<cmd> task failed: …"` instead of crashing the invoke. Smoke (local): create file/dir in tree, duplicate ("copy" suffix), rename, delete, edit+save in FileEditor, toggle an MCP server in settings. Smoke (ssh workspace): same operations on a remote file tree.
5. **`spawn_server` release path** — sidecar must still start hidden (CREATE_NO_WINDOW) and port-pick failure must still show the "failed to start opencode serve" error. Smoke: run release build (`run.ps1 build`) → app connects to sidecar; debug `run.ps1 dev` → sidecar stdout/stderr still visible in dev console.
6. **`spawn_new_instance`** — tray/JumpList "Open new window" spawns `--new-instance`. Smoke: tray menu → new window opens as independent process; taskbar JumpList entry same.
7. **`file_open`/`reveal_config_dir`/`reveal_plugins_dir`** now spawn via `win_command` internally in platform.rs — `cmd /C start` and `explorer /select` semantics unchanged. Smoke: "Open in file manager" from settings, open a file from the tree.
8. **Git spawn on Windows** — `run_blocking` now sets CREATE_NO_WINDOW via the helper (identical flag value `0x0800_0000`); non-interactive env vars untouched. Smoke: git status populates the panel; stage/discard still work in a Windows console-less environment.
9. **`platform::free_port`** — signature is `io::Result<u16>` (see D); voice.rs/remote.rs agents should adopt it accordingly or keep their local picks until then.

## Verification

Commands run (from `E:\project\Opencode-GUI\src-tauri`), final state after the parallel agents' in-flight edits settled:

- `cargo check` — **passes, 0 errors, 0 warnings** (`Finished dev profile`). First passes ran while parallel agents had the crate broken (pty.rs/voice.rs/discord.rs/remote.rs); zero diagnostics were ever attributed to `lib.rs`, `git.rs`, or `platform.rs` in any pass. Deleting `file_reveal` made `platform::reveal_path` dead (compiler-confirmed) → deleted; re-check then fully green.
- `cargo test --lib` — **18 passed, 0 failed**, including all 5 git.rs unit tests (`parses_porcelain`, `parses_nul_renames`, `marks_conflicts_once`, `unescapes_octal_utf8`, `handles_edge_heads`), remote.rs ×2, update.rs ×1, etc.
- Grep-verified zero remaining references to every deleted symbol (`git_root|git_clean|git_branches|…|git_reset|file_reveal|GitBranch|GitRemote|GitStash|base_dir|which_bin|reveal_path` across `src-tauri/src` and `src/` + `default_plugins/`).
- Dynamic-invoke audit: `GitPanel.tsx:579` (`rowAct`) and `:823` (`rowAct2`) are the only `invoke(<variable>)` sites; their possible values (`git_stage`, `git_unstage`, `git_discard`, `git_resolve`) are all retained.
- No files outside `src-tauri` were touched → repo-root `cargo check` not required.

## Deferred

- `win_command` adoption in voice.rs / remote.rs / browser.rs / terminals.rs / update.rs (5+2+2+2+5 remaining sites of the 17-site audit table) — other agents' files; they keep local consts for now per task constraints.
- `run_root`'s ignored `_timeout` param and inline blocking from async git commands (AUDIT §1 med) — not in this wave's scope.
- AGENTS.md platform-surface list still names `reveal_path` (file outside this wave's scope) — prune it when the docs wave lands.
