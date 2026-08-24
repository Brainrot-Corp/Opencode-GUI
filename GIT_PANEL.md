# Git panel — VS Code-style source control in the sidebar

Bottom strip of the left session viewer: stage, commit, push, commit & push,
pull, per-file stage/unstage/discard, popup diffs.

## Decisions (confirmed)

- **Full VS Code staging model** — separate Staged / Changes sections; commit
  takes only what's staged.
- **Discard included**, with a confirm step and danger-red hover styling.
- **Click a file → popup diff**, reusing the existing `Dialog` + `DiffLines`
  components from `DiffPanel.tsx`.

## Backend — new `src-tauri/src/git.rs`

Tauri commands shelling out to the `git` CLI (the opencode server exposes no
git API; no new npm deps). Registered in `lib.rs` `invoke_handler`, module
declared alongside `browser` / `voice`.

| Command | Git invocation | Notes |
|---|---|---|
| `git_status(dir)` | `git status --porcelain=v1 -b` | Returns `{ repo, branch, ahead, behind, files: [{path, x, y}] }`; `repo:false` when not a repo / git missing |
| `git_stage(dir, paths)` | `git add -- <paths>` | |
| `git_unstage(dir, paths)` | `git restore --staged -- <paths>` | |
| `git_discard(dir, paths)` | `git restore -- <paths>` | Throws away uncommitted edits |
| `git_commit(dir, msg)` | `git commit -m <msg>` | `-m` never opens an editor |
| `git_push(dir)` | `git push` | Uses existing remotes/credentials |
| `git_pull(dir)` | `git pull --no-edit` | |
| `git_diff(dir, path, staged)` | `git diff [--cached] -- <path>` | Raw patch for the popup |

Conventions:

- Empty `dir` resolves to the server cwd (`USERPROFILE`), mirroring
  `spawn_server`.
- All commands are `async` — blocking work stays off the main thread
  (same lock discipline as `browser.rs`).
- `CREATE_NO_WINDOW` on every spawn (release builds must not pop consoles).
- stderr is surfaced verbatim as the command's error string.
- Paths passed as separate args after `--`; porcelain v1 quoting of exotic
  filenames is parsed best-effort.
- *Commit & Push* has no dedicated command — the frontend chains
  `git_commit` → `git_push`.

## Frontend — `src/components/GitPanel.tsx` + `src/styles/git.css`

Self-contained component (workspace via `getDirectory()` from `api.ts`, zero
prop threading), mounted in `Sidebar.tsx` between `.sb-scroll` and
`.sb-resize` — hidden while the sidebar is collapsed, like everything else.

- **Collapsed strip**: branch icon + name, ahead/behind arrows, changed-file
  badge, chevron toggle. Open state persisted as `oc.git.open`.
- **Expanded**:
  - Commit message input.
  - Action row: Commit ✓ · Commit & Push · Push · Pull (disabled while an
    action runs).
  - **Staged** and **Changes** sections; each row shows its status letter
    (M/A/D/U color-coded) with hover actions stage / unstage / discard
    (discard confirms first).
  - Clicking a file opens the diff popup.
- **Refresh**: after every action + 4 s poll while expanded + on window
  focus.
- Not a repo → one quiet "Not a git repository" line.

Styling follows AGENTS.md: 6px spacing rhythm, glass tint matching the
sidebar, Font Awesome icons, JetBrains Mono for paths/status letters,
danger-tinted discard hover.

## Out of scope (add if ever wanted)

Branch switching/creation, fetch, stash, partial-line (hunk) staging.
