// file operations for the editor/file tree + workspace persistence.
// `ssh://` pseudo-paths run the same op on the remote over the tunnel
// (binary-safe writes via stdin); blocking fs work goes through
// spawn_blocking so async workers are never pinned.
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

use crate::remote::RemoteState;

// multi-window isolation: each OS window is its own process (spawned with
// --new-instance), but localStorage + the workspace file are shared across
// processes. Secondary windows therefore keep their workspace in a
// per-process variable (never the shared file) and namespace every
// window-local frontend key by the per-process scope id below — otherwise a
// workspace switch in one window leaks into the other (wrong repo in git,
// wrong sessions, dead terminal ids).
static BOOT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub(crate) fn boot_id() -> String {
    BOOT_ID
        .get_or_init(|| {
            // pid + nanos: unique across live processes, no extra dep for uuid
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{pid:x}-{nanos:x}")
        })
        .clone()
}

fn is_secondary() -> bool {
    std::env::args().any(|a| a == "--new-instance")
}

/// Post-update relaunch passes --restore-workspace (on top of
/// --new-instance): the old process is dead, so this window is effectively
/// the primary and may adopt the persisted workspace. Plain secondary
/// windows (tray/JumpList "Open new window") boot blank instead.
fn restore_ws_arg() -> bool {
    std::env::args().any(|a| a == "--restore-workspace")
}

/// Per-process workspace override for secondary windows — the shared file
/// stays owned by the primary window so secondaries can neither adopt nor
/// clobber it. Survives frontend reloads (the process persists).
static WINDOW_WS: Mutex<Option<String>> = Mutex::new(None);

/// True when this process owns the shared workspace file (primary, or the
/// sole post-update window). Secondaries use WINDOW_WS above.
pub(crate) fn file_backed_workspace() -> bool {
    !is_secondary() || restore_ws_arg()
}

#[derive(serde::Serialize)]
pub struct WindowScope {
    pub scope: String,
    pub primary: bool,
}

#[tauri::command]
pub fn window_scope() -> WindowScope {
    WindowScope {
        scope: boot_id(),
        primary: file_backed_workspace(),
    }
}

// workspace persistence — saved per local dev build so debug restarts reopen
// the same project without relying on WebView localStorage (devUrl origin
// differs from release, so localStorage would appear empty).
// NOTE: primary-window only (see file_backed_workspace); secondaries resolve
// through WINDOW_WS so concurrent windows stay independent.
fn workspace_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("workspace"))
}

#[tauri::command]
pub fn workspace_get(app: tauri::AppHandle) -> String {
    if !file_backed_workspace() {
        return WINDOW_WS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_default();
    }
    workspace_file(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[tauri::command]
pub fn workspace_set(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let t = path.trim().to_string();
    if !file_backed_workspace() {
        *WINDOW_WS.lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
        return Ok(());
    }
    let Some(file) = workspace_file(&app) else {
        return Err("no config dir".into());
    };
    if t.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, t).map_err(|e| e.to_string())
}

pub(crate) fn read_saved_workspace(app: &tauri::AppHandle) -> Option<PathBuf> {
    // secondary windows boot blank (server cwd = home); the per-window
    // ?directory= carries the real workspace. The post-update window restores
    // via --restore-workspace instead.
    if !file_backed_workspace() {
        return None;
    }
    let raw = workspace_get(app.clone());
    if raw.is_empty() {
        return None;
    }
    let p = PathBuf::from(raw);
    if p.is_dir() { Some(p) } else { None }
}

// save edited workspace files from the centered file viewer — the opencode
// server API is read-only for files, so writes go through the Tauri host.
// `ssh://` pseudo-paths run on the remote instead (binary-safe via stdin).
#[tauri::command]
pub async fn write_file(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    if crate::remote::is_remote(&path) {
        let t = crate::remote::split_remote(path.trim()).ok_or("bad ssh path")?;
        let uri = crate::remote::uri_of(&t);
        let script = format!(
            "mkdir -p {} && cat > {}",
            crate::remote::sh_quote(crate::remote::remote_parent(&t.path)),
            crate::remote::sh_quote(&t.path)
        );
        let app2 = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let remote = app2.state::<RemoteState>();
            crate::remote::exec_script(&app2, &remote, &uri, &script, Some(content.as_bytes()))
        })
        .await
        .map_err(|e| format!("write_file task failed: {e}"))?
        .map(|_| ());
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn file_create(app: tauri::AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    if crate::remote::is_remote(&path) {
        let t = crate::remote::split_remote(path.trim()).ok_or("bad ssh path")?;
        let uri = crate::remote::uri_of(&t);
        let script = if is_dir {
            format!("mkdir -p {}", crate::remote::sh_quote(&t.path))
        } else {
            format!(
                "mkdir -p {} && (test -e {} && echo exists || touch {})",
                crate::remote::sh_quote(crate::remote::remote_parent(&t.path)),
                crate::remote::sh_quote(&t.path),
                crate::remote::sh_quote(&t.path)
            )
        };
        let app2 = app.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            let remote = app2.state::<RemoteState>();
            crate::remote::exec_script(&app2, &remote, &uri, &script, None)
        })
        .await
        .map_err(|e| format!("file_create task failed: {e}"))??;
        if out.contains("exists") {
            return Err("file exists".into());
        }
        return Ok(());
    }
    if is_dir {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if std::path::Path::new(&path).exists() { return Err("file exists".into()); }
        std::fs::write(&path, "").map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn file_delete(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    if crate::remote::is_remote(&path) {
        let t = crate::remote::split_remote(path.trim()).ok_or("bad ssh path")?;
        let uri = crate::remote::uri_of(&t);
        let script = format!(
            "test -e {} || {{ echo missing; exit 0; }}; rm -rf {}",
            crate::remote::sh_quote(&t.path),
            crate::remote::sh_quote(&t.path)
        );
        let app2 = app.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            let remote = app2.state::<RemoteState>();
            crate::remote::exec_script(&app2, &remote, &uri, &script, None)
        })
        .await
        .map_err(|e| format!("file_delete task failed: {e}"))??;
        if out.contains("missing") {
            return Err("not found".into());
        }
        return Ok(());
    }
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err("not found".into()); }
    if p.is_dir() { std::fs::remove_dir_all(p).map_err(|e| e.to_string()) } else { std::fs::remove_file(p).map_err(|e| e.to_string()) }
}

#[tauri::command]
pub async fn file_rename(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() { return Err("empty path".into()); }
    if crate::remote::is_remote(&from) || crate::remote::is_remote(&to) {
        let f = crate::remote::split_remote(from.trim()).ok_or("bad ssh path")?;
        let d = crate::remote::split_remote(to.trim()).ok_or("bad ssh path")?;
        let uri = crate::remote::uri_of(&f);
        let script = format!(
            "test -e {} || {{ echo missing; exit 0; }}; test -e {} && {{ echo target-exists; exit 0; }}; mkdir -p {} && mv {} {}",
            crate::remote::sh_quote(&f.path),
            crate::remote::sh_quote(&d.path),
            crate::remote::sh_quote(crate::remote::remote_parent(&d.path)),
            crate::remote::sh_quote(&f.path),
            crate::remote::sh_quote(&d.path),
        );
        let app2 = app.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            let remote = app2.state::<RemoteState>();
            crate::remote::exec_script(&app2, &remote, &uri, &script, None)
        })
        .await
        .map_err(|e| format!("file_rename task failed: {e}"))??;
        if out.contains("missing") {
            return Err("not found".into());
        }
        if out.contains("target-exists") {
            return Err("target exists".into());
        }
        return Ok(());
    }
    if std::path::Path::new(&to).exists() { return Err("target exists".into()); }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn file_duplicate(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    if crate::remote::is_remote(&path) {
        let t = crate::remote::split_remote(path.trim()).ok_or("bad ssh path")?;
        let uri = crate::remote::uri_of(&t);
        let app2 = app.clone();
        return tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let remote = app2.state::<RemoteState>();
            // sibling copy-name scheme mirrors the local branch below
            let (parent, name) = match t.path.rfind('/') {
                Some(i) => (&t.path[..i], &t.path[i + 1..]),
                None => ("/", t.path.as_str()),
            };
            let (stem, ext) = match name.rfind('.') {
                Some(i) if i > 0 => (&name[..i], &name[i..]),
                _ => (name, ""),
            };
            for i in 1..100 {
                let cand_name = if i == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {i}{ext}") };
                let dest = if parent.is_empty() { format!("/{cand_name}") } else { format!("{parent}/{cand_name}") };
                let script = format!(
                    "test -e {} || {{ echo missing; exit 0; }}; test -e {} && {{ echo taken; exit 0; }}; cp -r {} {} && echo {}",
                    crate::remote::sh_quote(&t.path),
                    crate::remote::sh_quote(&dest),
                    crate::remote::sh_quote(&t.path),
                    crate::remote::sh_quote(&dest),
                    crate::remote::sh_quote(&dest),
                );
                let out = crate::remote::exec_script(&app2, &remote, &uri, &script, None)?;
                if out.contains("missing") {
                    return Err("not found".into());
                }
                if out.contains("taken") {
                    continue;
                }
                // echo back the pseudo-path so the frontend stays in ssh:// space
                let mut nt = t.clone();
                nt.path = dest;
                return Ok(crate::remote::uri_of(&nt));
            }
            Err("too many copies".into())
        })
        .await
        .map_err(|e| format!("file_duplicate task failed: {e}"))?;
    }
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err("not found".into()); }
    let parent = p.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("copy");
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    for i in 1..100 {
        let name = if i==1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {i}{ext}") };
        let dest = parent.join(&name);
        if !dest.exists() {
            if p.is_dir() {
                copy_dir_recursive(p, &dest).map_err(|e| e.to_string())?;
            } else {
                std::fs::copy(p, &dest).map_err(|e| e.to_string())?;
            }
            return Ok(dest.to_string_lossy().into_owned());
        }
    }
    Err("too many copies".into())
}

/// Copy OS-dragged files/folders (host paths) into a workspace folder.
/// Local-only: remote trees can't reach the drop source.
#[tauri::command]
pub async fn file_import(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    if dest_dir.trim().is_empty() { return Err("empty dest".into()); }
    if crate::remote::is_remote(&dest_dir) {
        return Err("local files can't be copied into a remote workspace".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let dest = std::path::PathBuf::from(dest_dir.trim());
        if !dest.is_dir() { return Err("target is not a folder".into()); }
        let mut done = Vec::new();
        for p in paths {
            let src = PathBuf::from(p.trim());
            if !src.exists() { continue; }
            let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
            let cand = free_copy_name(&dest, &name);
            let dst = dest.join(&cand);
            if src.is_dir() {
                copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())?;
            } else {
                std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
            }
            done.push(cand);
        }
        Ok(done)
    })
    .await
    .map_err(|e| format!("file_import task failed: {e}"))?
}

/// First free name in `dest`: `name`, then `name copy`, `name copy 2`, …
fn free_copy_name(dest: &std::path::Path, name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut cand = name.to_string();
    for i in 1..100 {
        if !dest.join(&cand).exists() { break; }
        cand = if i == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {i}{ext}") };
    }
    cand
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() { copy_dir_recursive(&entry.path(), &dst_path)?; } else { std::fs::copy(entry.path(), dst_path)?; }
    }
    Ok(())
}

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    if crate::remote::is_remote(&path) {
        return Err("remote files can't be opened locally".into());
    }
    crate::platform::open_path(&path).map(|_| ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn workspace_is_dir(app: tauri::AppHandle, path: String) -> bool {
    let p = path.trim().to_string();
    if crate::remote::is_remote(&p) {
        let Some(t) = crate::remote::split_remote(&p) else { return false; };
        let uri = crate::remote::uri_of(&t);
        let script = format!("test -d {}", crate::remote::sh_quote(&t.path));
        let app2 = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let remote = app2.state::<RemoteState>();
            crate::remote::exec_script(&app2, &remote, &uri, &script, None).is_ok()
        })
        .await
        .unwrap_or(false);
    }
    std::path::Path::new(&p).is_dir()
}

#[cfg(test)]
mod tests {
    use super::free_copy_name;

    #[test]
    fn free_copy_name_dedupes() {
        let base = std::env::temp_dir().join(format!("oc-ft-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        assert_eq!(free_copy_name(&base, "a.txt"), "a.txt");
        std::fs::write(base.join("a.txt"), "").unwrap();
        assert_eq!(free_copy_name(&base, "a.txt"), "a copy.txt");
        std::fs::write(base.join("a copy.txt"), "").unwrap();
        assert_eq!(free_copy_name(&base, "a.txt"), "a copy 2.txt");
        // no extension / dotfile shapes
        std::fs::write(base.join("Makefile"), "").unwrap();
        assert_eq!(free_copy_name(&base, "Makefile"), "Makefile copy");
        std::fs::write(base.join(".gitignore"), "").unwrap();
        assert_eq!(free_copy_name(&base, ".gitignore"), ".gitignore copy");
        let _ = std::fs::remove_dir_all(&base);
    }
}
