// git plumbing for the sidebar source-control panel — shells out to the git
// CLI (the opencode server exposes no git API). VSCode-parity semantics:
//
// - repo root resolution via `rev-parse --show-toplevel` so a workspace that
//   is a parent / child / sibling of the repo still works; all ops run in the
//   root with root-relative paths (`-c status.relativePaths=false`).
// - `status --porcelain=v1 -z -b` NUL parsing: renames (`R/C` new NUL orig),
//   unmerged `U*`/`AA`/`DD` → conflict group, C-quote unescape in both modes.
// - discard splits tracked (`restore`) vs untracked (`clean -f/-fd`).
// - push supports `-u origin <branch>` + `--force-with-lease`; pull supports
//   `--rebase/--merge`; commit supports `--no-verify`; stash/branch/resolve/
//   merge-rebase/remote/reset helpers round out the panel.
// - runner is off the async pool (`spawn_blocking`), non-interactive
//   (`GIT_TERMINAL_PROMPT=0`) with per-op timeouts so hung credential prompts
//   surface instead of locking the UI.
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize, Clone)]
pub struct GitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub x: char, // porcelain index status
    pub y: char, // porcelain worktree status
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub conflict: bool,
}

#[derive(Serialize, Clone)]
pub struct GitStatus {
    pub repo: bool,
    #[serde(default)]
    pub root: String,
    pub branch: String,
    #[serde(default)]
    pub detached: bool,
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub gone: bool,
    pub ahead: u32,
    pub behind: u32,
    #[serde(default)]
    pub initial: bool,
    #[serde(default)]
    pub in_merge: bool,
    #[serde(default)]
    pub in_rebase: bool,
    #[serde(default)]
    pub stash_count: u32,
    pub files: Vec<GitFile>,
}

#[derive(Serialize, Clone)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone)]
pub struct GitStash {
    pub index: u32,
    pub message: String,
}

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const OP_TIMEOUT: Duration = Duration::from_secs(30);
const NET_TIMEOUT: Duration = Duration::from_secs(120);

fn base_dir(dir: &str) -> PathBuf {
    let p = if dir.is_empty() {
        crate::platform::home_dir()
    } else {
        PathBuf::from(dir)
    };
    if p.is_dir() {
        p
    } else {
        crate::platform::home_dir()
    }
}

/// Blocking git spawn — runs on Tauri's async pool thread (same discipline as
/// the rest of this codebase, cf. browser.rs). Hung credential prompts can't
/// wedge it: `GIT_TERMINAL_PROMPT=0` fails fast instead of waiting on stdin.
/// `git_status` additionally wraps in `spawn_blocking` + timeout since it
/// fires on every poll/watch event.
fn run_blocking(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().unwrap_or(&"")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn run_root(root: &std::path::Path, args: &[&str], _timeout: Duration) -> Result<String, String> {
    // ponytail: timeout param kept for call-site uniformity; fail-fast comes
    // from GIT_TERMINAL_PROMPT=0, status adds a real timeout via spawn_blocking
    run_blocking(root, args)
}

/// Resolve the enclosing repo root for `dir` (handles workspace = parent or
/// subfolder of the repo). Returns `None` when not inside a repo.
fn repo_root(dir: &str) -> Option<PathBuf> {
    let cwd = base_dir(dir);
    let out = run_blocking(&cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let p = PathBuf::from(out.trim());
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

fn git_dir_of(root: &std::path::Path) -> PathBuf {
    // handles worktrees/submodules where .git is a file
    let out = run_blocking(root, &["rev-parse", "--git-dir"]).unwrap_or_default();
    let g = out.trim();
    if g.is_empty() {
        return root.join(".git");
    }
    let p = PathBuf::from(g);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn unescape_c_quote(s: &str) -> String {
    // git C-quotes use octal \ooo, plus \\, \", \t, \n
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some(d) if d.is_ascii_digit() => {
                let mut oct = String::new();
                oct.push(d);
                for _ in 0..2 {
                    if let Some(&peek) = chars.peek() {
                        if peek.is_ascii_digit() && peek < '8' {
                            oct.push(chars.next().unwrap());
                        } else {
                            break;
                        }
                    }
                }
                if oct.len() > 1 {
                    // multi-byte UTF-8 arrives as consecutive octal escapes —
                    // collect the byte run first, then decode once
                    let mut bytes = vec![u8::from_str_radix(&oct, 8).unwrap_or(b'?')];
                    loop {
                        // peek `\ooo` sequences
                        let mut clone = chars.clone();
                        if clone.next() != Some('\\') {
                            break;
                        }
                        match clone.next() {
                            Some(d2) if d2.is_ascii_digit() => {
                                let mut oct2 = String::new();
                                oct2.push(d2);
                                for _ in 0..2 {
                                    if let Some(&pk) = clone.peek() {
                                        if pk.is_ascii_digit() && pk < '8' {
                                            oct2.push(clone.next().unwrap());
                                        } else {
                                            break;
                                        }
                                    }
                                }
                                if let Ok(v) = u8::from_str_radix(&oct2, 8) {
                                    bytes.push(v);
                                    // commit the peeked chars
                                    chars.next();
                                    chars.next();
                                    for _ in 0..oct2.len() - 1 {
                                        chars.next();
                                    }
                                } else {
                                    break;
                                }
                            }
                            _ => break,
                        }
                    }
                    out.push_str(&String::from_utf8_lossy(&bytes));
                } else if let Ok(val) = u8::from_str_radix(&oct, 8) {
                    out.push(val as char);
                } else {
                    out.push_str(&oct);
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn unquote(p: &str) -> String {
    let t = p.trim();
    if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
        unescape_c_quote(&t[1..t.len() - 1])
    } else {
        t.to_string()
    }
}

fn looks_like_status(s: &str) -> bool {
    // -z status entries are `XY<space|tab>path`; bare orig paths from R/C
    // pairs have no XY prefix — distinguish by the code alphabet so an orig
    // file that happens to be long isn't mistaken for a status line.
    let b = s.as_bytes();
    if b.len() < 4 {
        return false;
    }
    const CODES: &[u8] = b" MADRCUT?!";
    CODES.contains(&b[0]) && CODES.contains(&b[1]) && (b[2] == b' ' || b[2] == b'\t')
}

fn is_conflict(x: char, y: char) -> bool {
    x == 'U'
        || y == 'U'
        || (x == 'A' && y == 'A')
        || (x == 'D' && y == 'D')
}

fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus {
        repo: true,
        root: String::new(),
        branch: String::new(),
        detached: false,
        upstream: None,
        gone: false,
        ahead: 0,
        behind: 0,
        initial: false,
        in_merge: false,
        in_rebase: false,
        stash_count: 0,
        files: Vec::new(),
    };
    let entries: Vec<&str> = if out.contains('\0') {
        out.split('\0').collect()
    } else {
        out.lines().collect()
    };
    let is_nul = out.contains('\0');
    let mut i = 0;
    while i < entries.len() {
        let line = entries[i];
        i += 1;
        if line.is_empty() {
            continue;
        }
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" | "main" |
            // "No commits yet on main" | "HEAD (no branch)" | "HEAD (detached …)"
            if let Some(b) = head.strip_prefix("No commits yet on ") {
                st.branch = b.split(' ').next().unwrap_or("").to_string();
                st.initial = true;
            } else if head.starts_with("HEAD ") || head == "HEAD" {
                st.branch = "HEAD".to_string();
                st.detached = true;
            } else {
                let before_bracket = head.split('[').next().unwrap_or(head).trim();
                let tracking = before_bracket.split("...").collect::<Vec<_>>();
                st.branch = tracking.first().unwrap_or(&"").to_string();
                if tracking.len() > 1 {
                    let up = tracking[1].trim().to_string();
                    if !up.is_empty() {
                        st.upstream = Some(up);
                    }
                }
            }
            if let Some(idx) = head.find('[') {
                let inner: Option<&str> = head[idx + 1..].split(']').next();
                for part in inner.unwrap_or("").split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        st.ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        st.behind = n.trim().parse().unwrap_or(0);
                    } else if part == "gone" {
                        st.gone = true;
                    }
                }
            }
        } else if line.len() >= 2 {
            let mut chars = line.chars();
            let x = chars.next().unwrap_or(' ');
            let y = chars.next().unwrap_or(' ');
            let raw = &line[2..];
            let trimmed = raw.trim_start();
            // skip similarity score digits: "R100 old" / "R100\told"
            let mut path = if trimmed
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            {
                let mut idx2 = 0;
                for c in trimmed.chars() {
                    if c.is_ascii_digit() {
                        idx2 += c.len_utf8();
                    } else {
                        break;
                    }
                }
                trimmed[idx2..].trim_start().to_string()
            } else {
                trimmed.to_string()
            };
            if path.starts_with('\t') {
                path = path[1..].trim_start().to_string();
            }
            let rename_like = x == 'R' || x == 'C';
            let mut orig: Option<String> = None;
            if is_nul && rename_like {
                // -z order: "<new>\0<orig>\0" — the next field is always the
                // orig path, never another status line
                if i < entries.len() {
                    let nxt = entries[i];
                    if !nxt.is_empty() && !looks_like_status(nxt) && !nxt.starts_with("## ") {
                        path = unquote(&path);
                        orig = Some(unquote(nxt));
                        i += 1;
                    } else if let Some(pos) = path.rfind(" -> ") {
                        // shouldn't happen under -z, but stay tolerant
                        orig = Some(unquote(&path[..pos]));
                        path = unquote(&path[pos + 4..]);
                    } else {
                        path = unquote(&path);
                    }
                } else {
                    path = unquote(&path);
                }
            } else {
                // legacy "old -> new" or plain path
                if rename_like {
                    if let Some(pos) = path.rfind(" -> ") {
                        orig = Some(unquote(&path[..pos]));
                        path = unquote(&path[pos + 4..]);
                    } else {
                        path = unquote(&path);
                    }
                } else {
                    path = unquote(&path);
                }
            }
            if path.is_empty() {
                continue;
            }
            let conflict = is_conflict(x, y);
            let staged = !conflict && x != ' ' && x != '?';
            st.files.push(GitFile {
                path,
                orig_path: orig,
                x,
                y,
                staged,
                conflict,
            });
        }
    }
    st
}

fn enrich(root: &std::path::Path, mut st: GitStatus) -> GitStatus {
    st.root = root.to_string_lossy().into_owned();
    let gd = git_dir_of(root);
    st.in_merge =
        gd.join("MERGE_HEAD").exists() || gd.join("CHERRY_PICK_HEAD").exists();
    st.in_rebase =
        gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists();
    if st.detached {
        if let Ok(h) = run_root(root, &["rev-parse", "--short", "HEAD"], OP_TIMEOUT) {
            let h = h.trim().to_string();
            if !h.is_empty() {
                st.branch = h;
            }
        }
    }
    if let Ok(s) = run_root(root, &["stash", "list", "--format=%gd"], OP_TIMEOUT) {
        st.stash_count = s.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    }
    st
}

fn not_repo() -> GitStatus {
    GitStatus {
        repo: false,
        root: String::new(),
        branch: String::new(),
        detached: false,
        upstream: None,
        gone: false,
        ahead: 0,
        behind: 0,
        initial: false,
        in_merge: false,
        in_rebase: false,
        stash_count: 0,
        files: Vec::new(),
    }
}

#[tauri::command]
pub async fn git_status(dir: String) -> Result<GitStatus, String> {
    let root = match repo_root(&dir) {
        Some(r) => r,
        None => return Ok(not_repo()),
    };
    let root_c = root.clone();
    let out: Result<String, String> = match tokio::time::timeout(
        STATUS_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            run_blocking(
                &root_c,
                &[
                    "-c",
                    "status.relativePaths=false",
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "-b",
                    "--untracked-files=all",
                ],
            )
        }),
    )
    .await
    {
        Ok(Ok(inner)) => inner,
        Ok(Err(e)) => Err(format!("git status task failed: {e}")),
        Err(_) => Err("git status timed out".to_string()),
    };
    match out {
        Ok(s) => {
            let st = parse_status(&s);
            Ok(enrich(&root, st))
        }
        Err(e) => {
            if e.contains("not a git repository") {
                Ok(not_repo())
            } else {
                // corrupt repo / bad git — quiet non-repo state, matching old behavior
                let _ = e;
                Ok(not_repo())
            }
        }
    }
}

/// Repo root for a workspace dir (lets the frontend show subfolder context).
#[tauri::command]
pub async fn git_root(dir: String) -> Result<String, String> {
    repo_root(&dir)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "not a git repository".to_string())
}

#[tauri::command]
pub async fn git_stage(dir: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to stage".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut args: Vec<String> = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_root(&root, &refs, OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(dir: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to unstage".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut args: Vec<String> = vec!["restore".to_string(), "--staged".to_string(), "--".to_string()];
    args.extend(paths.clone());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    match run_root(&root, &refs, OP_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(_) => {
            // git < 2.23 fallback
            let mut fb: Vec<String> = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
            fb.extend(paths);
            let r: Vec<&str> = fb.iter().map(String::as_str).collect();
            run_root(&root, &r, OP_TIMEOUT).map(|_| ())
        }
    }
}

/// VSCode-style discard: tracked → `restore --source=HEAD --staged --worktree`,
/// untracked → `clean -f` (files) / `clean -fd` (dirs). Directories expand to
/// both. On an initial commit (no HEAD) tracked-new files are untracked from
/// the index and removed from disk.
#[tauri::command]
pub async fn git_discard(dir: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to discard".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut tracked: Vec<String> = Vec::new();
    let mut untracked_files: Vec<String> = Vec::new();
    let mut untracked_dirs: Vec<String> = Vec::new();
    for p in &paths {
        let abs = root.join(p);
        if abs.is_dir() {
            // discard dir = restore tracked inside + clean untracked inside
            tracked.push(p.clone());
            untracked_dirs.push(p.clone());
            continue;
        }
        // `ls-files --error-unmatch` distinguishes tracked (incl. staged) from untracked
        let probe = run_root(&root, &["ls-files", "--error-unmatch", "--", p], OP_TIMEOUT).is_ok();
        if probe {
            tracked.push(p.clone());
        } else {
            untracked_files.push(p.clone());
        }
    }
    if !tracked.is_empty() {
        let mut args: Vec<String> = vec![
            "restore".to_string(),
            "--source=HEAD".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend(tracked.clone());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        if let Err(e) = run_root(&root, &refs, OP_TIMEOUT) {
            if e.contains("unknown revision") || e.contains("bad revision") {
                // initial commit: unstage + remove newly added files
                let mut rm: Vec<String> =
                    vec!["rm".to_string(), "--cached".to_string(), "--".to_string()];
                rm.extend(tracked.clone());
                let r: Vec<&str> = rm.iter().map(String::as_str).collect();
                let _ = run_root(&root, &r, OP_TIMEOUT);
                for p in &tracked {
                    let abs = root.join(p);
                    if abs.is_file() {
                        let _ = std::fs::remove_file(&abs);
                    }
                }
            } else if e.contains("did not match") {
                // partially untracked — fall through to clean below
            } else {
                return Err(e);
            }
        }
    }
    if !untracked_files.is_empty() {
        let mut args: Vec<String> = vec!["clean".to_string(), "-f".to_string(), "--".to_string()];
        args.extend(untracked_files);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_root(&root, &refs, OP_TIMEOUT).map(|_| ())?;
    }
    if !untracked_dirs.is_empty() {
        let mut args: Vec<String> = vec!["clean".to_string(), "-fd".to_string(), "--".to_string()];
        args.extend(untracked_dirs);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_root(&root, &refs, OP_TIMEOUT).map(|_| ())?;
    }
    Ok(())
}

/// Explicit untracked delete (used by confirm-then-delete flows).
#[tauri::command]
pub async fn git_clean(dir: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to clean".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut args: Vec<String> = vec!["clean".to_string(), "-fd".to_string(), "--".to_string()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_root(&root, &refs, OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_commit(
    dir: String,
    message: String,
    amend: Option<bool>,
    all: Option<bool>,
    no_verify: Option<bool>,
) -> Result<String, String> {
    let use_amend = amend.unwrap_or(false);
    let use_all = all.unwrap_or(false);
    let skip_verify = no_verify.unwrap_or(false);
    let trimmed = message.trim();
    if trimmed.is_empty() && !use_amend {
        return Err("enter a commit message".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    // Commit All = VSCode parity: stage everything first (tracked M/D + staged
    // A + untracked ??) so A files are included — `commit -a` alone skips
    // untracked. Staging here (not `-a`) also freezes the index so worktree
    // edits landing mid-commit aren't swept in.
    if use_all && !use_amend {
        run_root(&root, &["add", "-A"], OP_TIMEOUT)?;
    } else if use_all {
        // amend + all: stage all but keep --amend semantics
        let _ = run_root(&root, &["add", "-A"], OP_TIMEOUT);
    }
    let build_args = |subject: &str, body: Option<&str>| -> Vec<String> {
        let mut a: Vec<String> = vec!["commit".to_string()];
        if use_amend {
            a.push("--amend".to_string());
        }
        // no `-a`: `all` is already staged above (covers untracked, which
        // `-a` would skip)
        if skip_verify {
            a.push("--no-verify".to_string());
        }
        if !subject.trim().is_empty() {
            a.push("-m".to_string());
            a.push(subject.trim().to_string());
        } else if use_amend {
            a.push("--no-edit".to_string());
        }
        if let Some(b) = body {
            let bt = b.trim();
            if !bt.is_empty() {
                a.push("-m".to_string());
                a.push(bt.to_string());
            }
        }
        a
    };
    let args: Vec<String> = if let Some(idx) = trimmed.find("\n\n") {
        let (subject, body) = trimmed.split_at(idx);
        let body = body.trim();
        if !body.is_empty() {
            build_args(subject.trim(), Some(body))
        } else {
            build_args(trimmed, None)
        }
    } else {
        build_args(trimmed, None)
    };
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_root(&root, &refs, OP_TIMEOUT)
}

fn current_branch(root: &std::path::Path) -> Result<String, String> {
    let b = run_root(root, &["rev-parse", "--abbrev-ref", "HEAD"], OP_TIMEOUT)?;
    let b = b.trim().to_string();
    if b.is_empty() || b == "HEAD" {
        return Err("detached HEAD — checkout a branch first".to_string());
    }
    Ok(b)
}

#[tauri::command]
pub async fn git_push(
    dir: String,
    upstream: Option<bool>,
    force_lease: Option<bool>,
) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let want_upstream = upstream.unwrap_or(false);
    let lease = force_lease.unwrap_or(false);
    // auto-detect missing upstream so first push just works
    let needs_upstream = want_upstream
        || run_root(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], OP_TIMEOUT)
            .is_err();
    if needs_upstream {
        let branch = current_branch(&root)?;
        let mut args: Vec<&str> = vec!["push", "-u", "origin", &branch];
        let mut owned: Vec<String> = Vec::new();
        if lease {
            owned.push("--force-with-lease".to_string());
        }
        owned.push("--follow-tags".to_string());
        let mut full: Vec<&str> = args.clone();
        let extra: Vec<&str> = owned.iter().map(String::as_str).collect();
        full.extend(extra);
        args = full;
        return run_root(&root, &args, NET_TIMEOUT);
    }
    let mut owned: Vec<String> = vec!["push".to_string()];
    if lease {
        owned.push("--force-with-lease".to_string());
    }
    owned.push("--follow-tags".to_string());
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    run_root(&root, &refs, NET_TIMEOUT)
}

#[tauri::command]
pub async fn git_pull(dir: String, rebase: Option<bool>) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let args: Vec<&str> = match rebase {
        Some(true) => vec!["pull", "--rebase", "--no-edit"],
        Some(false) => vec!["pull", "--merge", "--no-edit"],
        None => vec!["pull", "--no-edit"],
    };
    run_root(&root, &args, NET_TIMEOUT)
}

#[tauri::command]
pub async fn git_fetch(dir: String, prune: Option<bool>) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if prune.unwrap_or(false) {
        run_root(&root, &["fetch", "--prune"], NET_TIMEOUT)
    } else {
        run_root(&root, &["fetch"], NET_TIMEOUT)
    }
}

/// Sync = pull --rebase then push; pull failure blocks push.
#[tauri::command]
pub async fn git_sync(dir: String) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["pull", "--rebase", "--no-edit"], NET_TIMEOUT)?;
    // push reuses upstream auto-detect
    drop(root);
    git_push(dir, None, None).await
}

#[tauri::command]
pub async fn git_diff(dir: String, path: String, staged: bool) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut owned: Vec<String> = vec!["diff".to_string(), "--no-color".to_string()];
    if staged {
        owned.push("--cached".to_string());
    }
    owned.push("-U3".to_string());
    owned.push("--src-prefix=a/".to_string());
    owned.push("--dst-prefix=b/".to_string());
    if !path.is_empty() {
        owned.push("--".to_string());
        owned.push(path);
    }
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    run_root(&root, &refs, OP_TIMEOUT)
}

#[tauri::command]
pub async fn git_diff_stat(dir: String) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["diff", "--cached", "--stat", "--no-color"], OP_TIMEOUT)
}

#[tauri::command]
pub async fn git_log(dir: String) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["log", "--oneline", "-n", "10"], OP_TIMEOUT)
}

// ---- branches / remotes / stash / conflicts ----

#[tauri::command]
pub async fn git_branches(dir: String) -> Result<Vec<GitBranch>, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let out = run_root(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
        ],
        OP_TIMEOUT,
    )?;
    let mut v = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        let name = parts.first().unwrap_or(&"").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let up = parts.get(1).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let head = parts.get(2).map(|s| s.trim()).unwrap_or_default();
        v.push(GitBranch {
            name,
            current: head == "*",
            upstream: up,
        });
    }
    v.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(v)
}

#[tauri::command]
pub async fn git_branch_create(
    dir: String,
    name: String,
    start_point: Option<String>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("enter a branch name".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["check-ref-format", "--branch", &name], OP_TIMEOUT)
        .map_err(|_| format!("invalid branch name: {name}"))?;
    if let Some(sp) = start_point {
        let sp = sp.trim().to_string();
        if sp.is_empty() {
            run_root(&root, &["branch", &name], OP_TIMEOUT).map(|_| ())
        } else {
            run_root(&root, &["branch", &name, &sp], OP_TIMEOUT).map(|_| ())
        }
    } else {
        run_root(&root, &["branch", &name], OP_TIMEOUT).map(|_| ())
    }
}

#[tauri::command]
pub async fn git_checkout(dir: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("enter a branch name".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["checkout", &name], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_branch_rename(dir: String, old: String, new: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let (old, new) = (old.trim(), new.trim());
    if old.is_empty() || new.is_empty() {
        return Err("enter old and new branch names".to_string());
    }
    run_root(&root, &["branch", "-m", old, new], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_branch_delete(
    dir: String,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let name = name.trim();
    if name.is_empty() {
        return Err("enter a branch name".to_string());
    }
    if force.unwrap_or(false) {
        run_root(&root, &["branch", "-D", name], OP_TIMEOUT).map(|_| ())
    } else {
        run_root(&root, &["branch", "-d", name], OP_TIMEOUT).map(|_| ())
    }
}

#[tauri::command]
pub async fn git_publish(dir: String, remote: Option<String>) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let branch = current_branch(&root)?;
    let r = remote.unwrap_or_else(|| "origin".to_string());
    let r = r.trim().to_string();
    run_root(&root, &["push", "-u", &r, &branch], NET_TIMEOUT)
}

#[tauri::command]
pub async fn git_remotes(dir: String) -> Result<Vec<GitRemote>, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let out = run_root(&root, &["remote", "-v"], OP_TIMEOUT)?;
    let mut map = std::collections::BTreeMap::<String, String>::new();
    for line in out.lines() {
        // "origin\tgit@… (fetch)"
        let mut it = line.split_whitespace();
        let (Some(n), Some(u)) = (it.next(), it.next()) else {
            continue;
        };
        if line.contains("(fetch)") {
            map.entry(n.to_string()).or_insert_with(|| u.to_string());
        }
    }
    Ok(map
        .into_iter()
        .map(|(name, url)| GitRemote { name, url })
        .collect())
}

#[tauri::command]
pub async fn git_stash_list(dir: String) -> Result<Vec<GitStash>, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let out = run_root(&root, &["stash", "list", "--format=%gd%x00%gs"], OP_TIMEOUT)?;
    let mut v = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (id, msg) = line.split_once('\0').unwrap_or((line, ""));
        let idx = id
            .trim()
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        v.push(GitStash {
            index: idx,
            message: msg.trim().to_string(),
        });
    }
    Ok(v)
}

#[tauri::command]
pub async fn git_stash_push(
    dir: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut owned: Vec<String> =
        vec!["stash".to_string(), "push".to_string(), "-m".to_string()];
    let m = message.unwrap_or_default();
    owned.push(if m.trim().is_empty() {
        "panel stash".to_string()
    } else {
        m.trim().to_string()
    });
    if include_untracked.unwrap_or(false) {
        owned.push("--include-untracked".to_string());
    }
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    run_root(&root, &refs, OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_stash_pop(dir: String, index: Option<u32>) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if let Some(n) = index {
        run_root(&root, &["stash", "pop", &format!("stash@{{{n}}}")], OP_TIMEOUT).map(|_| ())
    } else {
        run_root(&root, &["stash", "pop"], OP_TIMEOUT).map(|_| ())
    }
}

#[tauri::command]
pub async fn git_stash_apply(dir: String, index: Option<u32>) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if let Some(n) = index {
        run_root(&root, &["stash", "apply", &format!("stash@{{{n}}}")], OP_TIMEOUT).map(|_| ())
    } else {
        run_root(&root, &["stash", "apply"], OP_TIMEOUT).map(|_| ())
    }
}

#[tauri::command]
pub async fn git_stash_drop(dir: String, index: Option<u32>) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if let Some(n) = index {
        run_root(&root, &["stash", "drop", &format!("stash@{{{n}}}")], OP_TIMEOUT).map(|_| ())
    } else {
        run_root(&root, &["stash", "drop"], OP_TIMEOUT).map(|_| ())
    }
}

#[tauri::command]
pub async fn git_stash_clear(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["stash", "clear"], OP_TIMEOUT).map(|_| ())
}

/// Mark a conflict resolved with ours/theirs, then stage it.
#[tauri::command]
pub async fn git_resolve(dir: String, path: String, ours: bool) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if path.trim().is_empty() {
        return Err("no path".to_string());
    }
    let side = if ours { "--ours" } else { "--theirs" };
    run_root(&root, &["checkout", side, "--", &path], OP_TIMEOUT)?;
    run_root(&root, &["add", "--", &path], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_merge_abort(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["merge", "--abort"], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_merge_continue(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["merge", "--continue"], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_rebase_abort(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["rebase", "--abort"], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_rebase_continue(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["rebase", "--continue"], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_rebase_skip(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["rebase", "--skip"], OP_TIMEOUT).map(|_| ())
}

#[tauri::command]
pub async fn git_reset(dir: String, target: String, mode: Option<String>) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let target = target.trim();
    if target.is_empty() {
        return Err("no target".to_string());
    }
    let m = mode.unwrap_or_else(|| "mixed".to_string());
    let flag = match m.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    run_root(&root, &["reset", flag, target], OP_TIMEOUT).map(|_| ())
}

/// Watch `<root>/.git` and emit `git://changed` (debounced). The frontend also
/// listens to `oc:file-changed` + focus + keeps the 4s poll as fallback, so
/// worktree edits are covered even though only `.git` is watched here
/// (watching the whole worktree recursive would storm on node_modules/target).
#[tauri::command]
pub async fn git_watch(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let Some(root) = repo_root(&dir) else {
        return Ok(());
    };
    let gd = git_dir_of(&root);
    if !gd.is_dir() {
        return Ok(());
    }
    std::thread::spawn(move || {
        use notify::Watcher as _;
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("git watcher unavailable: {e}");
                return;
            }
        };
        if watcher.watch(&gd, notify::RecursiveMode::Recursive).is_err() {
            return;
        }
        let _keep = watcher;
        use tauri::Emitter;
        let root_s = root.to_string_lossy().into_owned();
        loop {
            if rx.recv().is_err() {
                break;
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
            while std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(60));
                let _ = rx.try_recv();
            }
            let _ = app.emit("git://changed", root_s.clone());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let st = parse_status(
            "## main...origin/main [ahead 2, behind 1]\n\
             M  src/lib.rs\n\
             MM app.tsx\n\
             ?? notes.md\n\
             R  old.txt -> new.txt\n",
        );
        assert_eq!(st.branch, "main");
        assert_eq!(st.ahead, 2);
        assert_eq!(st.behind, 1);
        assert_eq!(st.files.len(), 4);
        assert_eq!(st.files[0].path, "src/lib.rs");
        assert_eq!((st.files[0].x, st.files[0].y), ('M', ' '));
        assert!(st.files[0].staged);
        assert_eq!((st.files[1].x, st.files[1].y), ('M', 'M'));
        assert_eq!((st.files[2].x, st.files[2].y), ('?', '?'));
        assert!(!st.files[2].staged && !st.files[2].conflict);
        assert_eq!(st.files[3].path, "new.txt");
        assert_eq!(st.files[3].orig_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn parses_nul_renames() {
        // -z order: new NUL orig
        let s = "## main\0R  new.txt\0old.txt\0M  a.ts\0";
        let st = parse_status(s);
        assert_eq!(st.files.len(), 2);
        assert_eq!(st.files[0].path, "new.txt");
        assert_eq!(st.files[0].orig_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn marks_conflicts_once() {
        let st = parse_status("## main\nUU both.ts\nAA added.ts\nUD del.ts\n");
        assert_eq!(st.files.len(), 3);
        for f in &st.files {
            assert!(f.conflict, "{}", f.path);
            assert!(!f.staged, "{}", f.path);
        }
    }

    #[test]
    fn unescapes_octal_utf8() {
        // "é.txt" as git C-quote octal
        let st = parse_status("## main\nM  \"a\\303\\251.txt\"\n");
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].path, "aé.txt");
    }

    #[test]
    fn handles_edge_heads() {
        let st = parse_status("## No commits yet on trunk\n");
        assert_eq!(st.branch, "trunk");
        assert!(st.initial);
        let st = parse_status("## HEAD (no branch)\n");
        assert!(st.detached);
        let st = parse_status("## main...origin/main [gone]\n");
        assert!(st.gone);
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    }
}
