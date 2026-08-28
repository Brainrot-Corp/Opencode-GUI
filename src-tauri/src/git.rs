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

// empty dir resolves to the server cwd (USERPROFILE), mirroring spawn_server
fn workdir(dir: &str) -> std::path::PathBuf {
    if dir.is_empty() {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        return std::path::PathBuf::from(home);
    }
    std::path::PathBuf::from(dir)
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

fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus {
        repo: true,
        branch: String::new(),
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };
    for line in out.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" | "main" |
            // "No commits yet on main" | "HEAD (no branch)"
            st.branch = if let Some(b) = head.strip_prefix("No commits yet on ") {
                b.to_string()
            } else {
                head.split("...").next().unwrap_or("").split(' ').next().unwrap_or("").to_string()
            };
            if let Some(i) = head.find('[') {
                let inner: Option<&str> = head[i + 1..].split(']').next();
                for part in inner.unwrap_or("").split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        st.ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        st.behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
        } else if line.len() >= 4 {
            let mut chars = line.chars();
            let x = chars.next().unwrap_or(' ');
            let y = chars.next().unwrap_or(' ');
            // exact "XY path" layout — skip 3 chars keeps interior spacing
            let mut path: String = chars.skip(1).collect();
            // renames report "old -> new" — track the new name
            if let Some(i) = path.rfind(" -> ") {
                path = path[i + 4..].to_string();
            }
            // C-quoted exotic paths: best-effort unquote (escapes stay raw)
            if path.starts_with('"') && path.ends_with('"') && path.len() >= 2 {
                path = path[1..path.len() - 1].to_string();
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
    match run(&dir, &["status", "--porcelain=v1", "-b", "--untracked-files=normal"]) {
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
pub async fn git_commit(dir: String, message: String) -> Result<String, String> {
    // body opt-in sends "subject\n\nbody" — pass as two -m to preserve paragraph
    let trimmed = message.trim();
    if let Some(idx) = trimmed.find("\n\n") {
        let (subject, body) = trimmed.split_at(idx);
        let body = body.trim();
        if !body.is_empty() {
            return run(&dir, &["commit", "-m", subject.trim(), "-m", body]);
        }
    }
    run(&dir, &["commit", "-m", trimmed])
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
