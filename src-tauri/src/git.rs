// git plumbing for the sidebar source-control panel — shells out to the git
// CLI (the opencode server exposes no git API). All commands are async so the
// blocking subprocess never runs on the main thread (browser.rs discipline).
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct GitFile {
    pub path: String,
    pub x: char, // porcelain index status
    pub y: char, // porcelain worktree status
}

#[derive(Serialize)]
pub struct GitStatus {
    pub repo: bool,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

// empty dir resolves to the server cwd (home_dir), mirroring spawn_server
fn workdir(dir: &str) -> std::path::PathBuf {
    if dir.is_empty() {
        return crate::platform::home_dir();
    }
    let p = std::path::PathBuf::from(dir);
    if p.is_dir() { p } else { crate::platform::home_dir() }
}

fn run(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(workdir(dir));
    // always swallow the console window on Windows — a flash per git call
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("git {}: {e}", args.first().unwrap_or(&"")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
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
                // octal up to 3 digits
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
                if let Ok(val) = u8::from_str_radix(&oct, 8) {
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

fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus {
        repo: true,
        branch: String::new(),
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };
    // EH-13: porcelain v1 -z is NUL delimited; avoids " -> " hacks and C-quote issues.
    // Support both NUL and legacy lines for tests/back-compat.
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
            // "No commits yet on main" | "HEAD (no branch)"
            st.branch = if let Some(b) = head.strip_prefix("No commits yet on ") {
                b.to_string()
            } else {
                head.split("...").next().unwrap_or("").split(' ').next().unwrap_or("").to_string()
            };
            if let Some(idx) = head.find('[') {
                let inner: Option<&str> = head[idx + 1..].split(']').next();
                for part in inner.unwrap_or("").split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        st.ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        st.behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
        } else if line.len() >= 2 {
            let mut chars = line.chars();
            let x = chars.next().unwrap_or(' ');
            let y = chars.next().unwrap_or(' ');
            // path is after XY + optional score/delimiter (space or tab)
            // e.g. "R  old", "R100 old", "M  file"
            let raw = &line[2..];
            // trim leading delimiters (space, tab, digits for score)
            // For "R100 old" -> raw="100 old" -> skip digits -> " old" -> trim -> "old"
            let trimmed = raw.trim_start();
            let mut path = if trimmed
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            {
                // skip leading score digits
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
            // tab-separated renames (R100\told) may use tab after score
            if path.starts_with('\t') {
                path = path[1..].trim_start().to_string();
            }
            let is_rename = x == 'R' || y == 'R' || x == 'C' || y == 'C';
            if is_nul && is_rename {
                // NUL mode: next entry is the new name
                if i < entries.len() {
                    let nxt = entries[i];
                    if !nxt.is_empty() && !nxt.starts_with("## ") {
                        // next is new path, not a status line
                        path = nxt.to_string();
                        i += 1;
                    } else if let Some(pos) = path.rfind(" -> ") {
                        // fallback: handle arrow if somehow still there
                        path = path[pos + 4..].to_string();
                    }
                }
            } else if !is_nul {
                // legacy lines: rename is "old -> new"; track new, but avoid
                // mis-parsing filenames that legitimately contain " -> "
                if is_rename {
                    if let Some(pos) = path.rfind(" -> ") {
                        path = path[pos + 4..].to_string();
                    }
                }
                // C-quoted exotic paths: unescape properly (was previously left raw)
                if path.starts_with('"') && path.ends_with('"') && path.len() >= 2 {
                    let inner = &path[1..path.len() - 1];
                    path = unescape_c_quote(inner);
                }
            }
            if !path.is_empty() {
                st.files.push(GitFile { path, x, y });
            }
        }
    }
    st
}

#[tauri::command]
pub async fn git_status(dir: String) -> Result<GitStatus, String> {
    match run(&dir, &["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]) {
        Ok(out) => Ok(parse_status(&out)),
        // not a repo / git missing — quiet state for the panel, not an error
        Err(_) => Ok(GitStatus {
            repo: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        }),
    }
}

#[tauri::command]
pub async fn git_stage(dir: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(&dir, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(dir: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(&dir, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_discard(dir: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["restore", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(&dir, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_commit(dir: String, message: String, amend: Option<bool>, all: Option<bool>) -> Result<String, String> {
    let use_amend = amend.unwrap_or(false);
    let use_all = all.unwrap_or(false);
    // body opt-in sends "subject\n\nbody" — pass as two -m to preserve paragraph
    let trimmed = message.trim();
    let build_args = |subject: &str, body: Option<&str>| -> Vec<String> {
        let mut a: Vec<String> = vec!["commit".to_string()];
        if use_amend { a.push("--amend".to_string()); }
        if use_all { a.push("-a".to_string()); }
        a.push("-m".to_string());
        a.push(subject.trim().to_string());
        if let Some(b) = body {
            let bt = b.trim();
            if !bt.is_empty() {
                a.push("-m".to_string());
                a.push(bt.to_string());
            }
        }
        a
    };
    if let Some(idx) = trimmed.find("\n\n") {
        let (subject, body) = trimmed.split_at(idx);
        let body = body.trim();
        if !body.is_empty() {
            let args = build_args(subject.trim(), Some(body));
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            return run(&dir, &refs);
        }
    }
    let args = build_args(trimmed, None);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(&dir, &refs)
}

#[tauri::command]
pub async fn git_push(dir: String) -> Result<String, String> {
    run(&dir, &["push"])
}

#[tauri::command]
pub async fn git_pull(dir: String) -> Result<String, String> {
    run(&dir, &["pull", "--no-edit"])
}

#[tauri::command]
pub async fn git_fetch(dir: String) -> Result<String, String> {
    run(&dir, &["fetch"])
}

#[tauri::command]
pub async fn git_diff(dir: String, path: String, staged: bool) -> Result<String, String> {
    // empty path = whole diff (used for AI commit messages)
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.push("-U1");
    if !path.is_empty() {
        args.push("--");
        args.push(&path);
    }
    run(&dir, &args)
}

#[tauri::command]
pub async fn git_diff_stat(dir: String) -> Result<String, String> {
    run(&dir, &["diff", "--cached", "--stat", "--no-color"])
}

#[tauri::command]
pub async fn git_log(dir: String) -> Result<String, String> {
    run(&dir, &["log", "--oneline", "-n", "10"])
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
        assert_eq!((st.files[1].x, st.files[1].y), ('M', 'M'));
        assert_eq!((st.files[2].x, st.files[2].y), ('?', '?'));
        assert_eq!(st.files[3].path, "new.txt");
    }

    #[test]
    fn handles_edge_heads() {
        let st = parse_status("## No commits yet on trunk\n");
        assert_eq!(st.branch, "trunk");
        assert_eq!(st.files.len(), 0);
        let st = parse_status("## HEAD (no branch)\n");
        assert_eq!(st.branch, "HEAD");
    }
}
