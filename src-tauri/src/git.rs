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
//   `--rebase/--merge`; commit supports `--no-verify`; stash push/pop and
//   resolve/merge-rebase helpers round out the panel.
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

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const OP_TIMEOUT: Duration = Duration::from_secs(30);
const NET_TIMEOUT: Duration = Duration::from_secs(120);

/// Blocking git spawn — runs on Tauri's blocking pool (never on an async
/// worker; every command goes through `run_root` which wraps in
/// `spawn_blocking` + `tokio::time::timeout`). Hung credential prompts can't
/// wedge it: `GIT_TERMINAL_PROMPT=0` fails fast instead of waiting on stdin.
///
/// Remote workspaces (`ssh://…` pseudo-paths from repo_root) re-run over the
/// ssh tunnel instead — same argv, `git -C <remote-path>`.
fn run_blocking(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let s = cwd.to_string_lossy();
    if crate::remote::is_remote(&s) {
        return crate::remote::exec_git_global(&s, args);
    }
    let mut cmd = crate::platform::win_command("git");
    cmd.args(args).current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("LC_ALL", "C");
    let out = cmd
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().unwrap_or(&"")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The single git-run boundary for every command: the blocking child process
/// moves to the blocking pool and the (previously ignored) timeout actually
/// kills the await — so a hung credential prompt or dead remote can never
/// pin an async worker for NET_TIMEOUT=120s. `repo_root` calls stay inline
/// only via `run_blocking` for rev-parse probes, which fail fast anyway.
async fn run_root(
    root: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let root = root.to_owned();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let op = args.first().cloned().unwrap_or_else(|| "git".into());
    let fut = tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_blocking(&root, &refs)
    });
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(inner)) => inner.map_err(|e| format!("git task failed: {e}")),
        Ok(Err(e)) => Err(format!("git task failed: {e}")),
        Err(_) => Err(format!(
            "git {} timed out after {}s",
            op,
            timeout.as_secs()
        )),
    }
}

/// Resolve the enclosing repo root for `dir` (handles workspace = parent or
/// subfolder of the repo). Returns `None` when not inside a repo.
/// Remote dirs resolve over ssh and come back as `ssh://…` pseudo-paths so
/// every downstream `run_root` call routes remotely with zero call-site churn.
fn repo_root(dir: &str) -> Option<PathBuf> {
    if crate::remote::is_remote(dir) {
        let out = crate::remote::exec_git_global(dir, &["rev-parse", "--show-toplevel"]).ok()?;
        let rp = out.trim();
        if rp.is_empty() || !rp.starts_with('/') {
            return None;
        }
        if !crate::remote::test_global(dir, "-d", rp) {
            return None;
        }
        return crate::remote::pseudo_with_abs(dir, rp).map(PathBuf::from);
    }
    let cwd = crate::platform::resolve_workdir(dir);
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
    if crate::remote::is_remote_path(root) {
        let rs = root.to_string_lossy().into_owned();
        if g.is_empty() {
            return PathBuf::from(crate::remote::pseudo_join(&rs, ".git"));
        }
        if g.starts_with('/') {
            if let Some(p) = crate::remote::pseudo_with_abs(&rs, g) {
                return PathBuf::from(p);
            }
        }
        return PathBuf::from(crate::remote::pseudo_join(&rs, g));
    }
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

/// Pseudo-path-aware predicates — `ssh://…` paths test remotely, so Windows
/// PathBuf separators never leak into remote posix paths.
fn path_exists(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy();
    match crate::remote::split_remote(&s) {
        Some(t) => crate::remote::test_global(&crate::remote::uri_of(&t), "-e", &t.path),
        None => p.exists(),
    }
}

fn path_is_dir(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy();
    match crate::remote::split_remote(&s) {
        Some(t) => crate::remote::test_global(&crate::remote::uri_of(&t), "-d", &t.path),
        None => p.is_dir(),
    }
}

fn path_is_file(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy();
    match crate::remote::split_remote(&s) {
        Some(t) => crate::remote::test_global(&crate::remote::uri_of(&t), "-f", &t.path),
        None => p.is_file(),
    }
}

/// Posix-correct join for pseudo-paths, std join otherwise.
fn path_join(base: &std::path::Path, rel: &str) -> PathBuf {
    let s = base.to_string_lossy();
    if crate::remote::is_remote(&s) {
        PathBuf::from(crate::remote::pseudo_join(&s, rel))
    } else {
        base.join(rel)
    }
}

fn remove_path(p: &std::path::Path) {
    let s = p.to_string_lossy();
    if let Some(t) = crate::remote::split_remote(&s) {
        let uri = crate::remote::uri_of(&t);
        let _ = crate::remote::script_global(&uri, &format!("rm -f {}", crate::remote::sh_quote(&t.path)));
    } else if path_is_file(p) {
        let _ = std::fs::remove_file(p);
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
        path_exists(&path_join(&gd, "MERGE_HEAD")) || path_exists(&path_join(&gd, "CHERRY_PICK_HEAD"));
    st.in_rebase =
        path_exists(&path_join(&gd, "rebase-merge")) || path_exists(&path_join(&gd, "rebase-apply"));
    // rev-parse probes fail fast (no network), so enrich() stays sync — it
    // runs inside git_status's spawn_blocking + timeout wrapper
    if st.detached {
        if let Ok(h) = run_blocking(root, &["rev-parse", "--short", "HEAD"]) {
            let h = h.trim().to_string();
            if !h.is_empty() {
                st.branch = h;
            }
        }
    }
    if let Ok(s) = run_blocking(root, &["stash", "list", "--format=%gd"]) {
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

#[tauri::command]
pub async fn git_stage(dir: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to stage".to_string());
    }
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let mut args: Vec<String> = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_root(&root, &refs, OP_TIMEOUT).await.map(|_| ())
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
    match run_root(&root, &refs, OP_TIMEOUT).await {
        Ok(_) => Ok(()),
        Err(_) => {
            // git < 2.23 fallback
            let mut fb: Vec<String> = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
            fb.extend(paths);
            let r: Vec<&str> = fb.iter().map(String::as_str).collect();
            run_root(&root, &r, OP_TIMEOUT).await.map(|_| ())
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
        let abs = path_join(&root, p);
        if path_is_dir(&abs) {
            // discard dir = restore tracked inside + clean untracked inside
            tracked.push(p.clone());
            untracked_dirs.push(p.clone());
            continue;
        }
        // `ls-files --error-unmatch` distinguishes tracked (incl. staged) from untracked
        let probe = run_root(&root, &["ls-files", "--error-unmatch", "--", p], OP_TIMEOUT).await.is_ok();
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
        if let Err(e) = run_root(&root, &refs, OP_TIMEOUT).await {
            if e.contains("unknown revision") || e.contains("bad revision") {
                // initial commit: unstage + remove newly added files
                let mut rm: Vec<String> =
                    vec!["rm".to_string(), "--cached".to_string(), "--".to_string()];
                rm.extend(tracked.clone());
                let r: Vec<&str> = rm.iter().map(String::as_str).collect();
                let _ = run_root(&root, &r, OP_TIMEOUT).await;
                for p in &tracked {
                    remove_path(&path_join(&root, p));
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
        run_root(&root, &refs, OP_TIMEOUT).await.map(|_| ())?;
    }
    if !untracked_dirs.is_empty() {
        let mut args: Vec<String> = vec!["clean".to_string(), "-fd".to_string(), "--".to_string()];
        args.extend(untracked_dirs);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_root(&root, &refs, OP_TIMEOUT).await.map(|_| ())?;
    }
    Ok(())
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
        run_root(&root, &["add", "-A"], OP_TIMEOUT).await?;
    } else if use_all {
        // amend + all: stage all but keep --amend semantics
        let _ = run_root(&root, &["add", "-A"], OP_TIMEOUT).await;
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
    run_root(&root, &refs, OP_TIMEOUT).await
}

async fn current_branch(root: &std::path::Path) -> Result<String, String> {
    let b = run_root(root, &["rev-parse", "--abbrev-ref", "HEAD"], OP_TIMEOUT).await?;
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
            .await
            .is_err();
    if needs_upstream {
        let branch = current_branch(&root).await?;
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
        return run_root(&root, &args, NET_TIMEOUT).await;
    }
    let mut owned: Vec<String> = vec!["push".to_string()];
    if lease {
        owned.push("--force-with-lease".to_string());
    }
    owned.push("--follow-tags".to_string());
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    run_root(&root, &refs, NET_TIMEOUT).await
}

#[tauri::command]
pub async fn git_pull(dir: String, rebase: Option<bool>) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let args: Vec<&str> = match rebase {
        Some(true) => vec!["pull", "--rebase", "--no-edit"],
        Some(false) => vec!["pull", "--merge", "--no-edit"],
        None => vec!["pull", "--no-edit"],
    };
    run_root(&root, &args, NET_TIMEOUT).await
}

#[tauri::command]
pub async fn git_fetch(dir: String, prune: Option<bool>) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if prune.unwrap_or(false) {
        run_root(&root, &["fetch", "--prune"], NET_TIMEOUT).await
    } else {
        run_root(&root, &["fetch"], NET_TIMEOUT).await
    }
}

/// Sync = pull --rebase then push; pull failure blocks push.
#[tauri::command]
pub async fn git_sync(dir: String) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["pull", "--rebase", "--no-edit"], NET_TIMEOUT).await?;
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
    run_root(&root, &refs, OP_TIMEOUT).await
}

#[tauri::command]
pub async fn git_diff_stat(dir: String) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["diff", "--cached", "--stat", "--no-color"], OP_TIMEOUT).await
}

#[tauri::command]
pub async fn git_log(dir: String) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["log", "--oneline", "-n", "10"], OP_TIMEOUT).await
}

// ---- publish / stash / conflicts ----

#[tauri::command]
pub async fn git_publish(dir: String, remote: Option<String>) -> Result<String, String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    let branch = current_branch(&root).await?;
    let r = remote.unwrap_or_else(|| "origin".to_string());
    let r = r.trim().to_string();
    run_root(&root, &["push", "-u", &r, &branch], NET_TIMEOUT).await
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
    run_root(&root, &refs, OP_TIMEOUT).await.map(|_| ())
}

#[tauri::command]
pub async fn git_stash_pop(dir: String, index: Option<u32>) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if let Some(n) = index {
        run_root(&root, &["stash", "pop", &format!("stash@{{{n}}}")], OP_TIMEOUT).await.map(|_| ())
    } else {
        run_root(&root, &["stash", "pop"], OP_TIMEOUT).await.map(|_| ())
    }
}

/// Mark a conflict resolved with ours/theirs, then stage it.
#[tauri::command]
pub async fn git_resolve(dir: String, path: String, ours: bool) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    if path.trim().is_empty() {
        return Err("no path".to_string());
    }
    let side = if ours { "--ours" } else { "--theirs" };
    run_root(&root, &["checkout", side, "--", &path], OP_TIMEOUT).await?;
    run_root(&root, &["add", "--", &path], OP_TIMEOUT).await.map(|_| ())
}

#[tauri::command]
pub async fn git_merge_abort(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["merge", "--abort"], OP_TIMEOUT).await.map(|_| ())
}

#[tauri::command]
pub async fn git_merge_continue(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["merge", "--continue"], OP_TIMEOUT).await.map(|_| ())
}

#[tauri::command]
pub async fn git_rebase_abort(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["rebase", "--abort"], OP_TIMEOUT).await.map(|_| ())
}

#[tauri::command]
pub async fn git_rebase_continue(dir: String) -> Result<(), String> {
    let root = repo_root(&dir).ok_or_else(|| "not a git repository".to_string())?;
    run_root(&root, &["rebase", "--continue"], OP_TIMEOUT).await.map(|_| ())
}

/// Watch `<root>/.git` and emit `git://changed` (debounced). The frontend also
/// listens to `oc:file-changed` + focus + keeps the 4s poll as fallback, so
/// worktree edits are covered even though only `.git` is watched here
/// (watching the whole worktree recursive would storm on node_modules/target).
///
/// One watcher per repo root per process: workspace switches re-invoke this
/// with a new root and must not leak a thread per switch.
static WATCHED_ROOTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

#[tauri::command]
pub async fn git_watch(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let Some(root) = repo_root(&dir) else {
        return Ok(());
    };
    let root_key = root.to_string_lossy().into_owned();
    {
        let mut seen = WATCHED_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
        if !seen.insert(root_key.clone()) {
            return Ok(()); // already watched — no duplicate thread
        }
    }
    let gd = git_dir_of(&root);
    if !path_is_dir(&gd) {
        return Ok(());
    }
    if crate::remote::is_remote_path(&root) {
        // no filesystem notify over ssh — poll HEAD + porcelain digest (the
        // frontend already polls every 4s too; this keeps push events live)
        let root_s = root.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            use tauri::Emitter;
            let snapshot = || {
                let head = crate::remote::exec_git_global(&root_s, &["rev-parse", "HEAD"]).unwrap_or_default();
                let st = crate::remote::exec_git_global(
                    &root_s,
                    &["-c", "status.relativePaths=false", "status", "--porcelain=v1", "-z", "-b"],
                )
                .unwrap_or_default();
                format!("{}:{}", head.trim(), st.len())
            };
            let mut last = snapshot();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let cur = snapshot();
                if cur != last {
                    last = cur;
                    let _ = app.emit("git://changed", root_s.clone());
                }
            }
        });
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