use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State, WindowEvent};

mod browser;
use browser::{browser_back, browser_close, browser_forward, browser_navigate, browser_open,
    browser_reload, open_app, open_external, tiktok_close, tiktok_navigate, tiktok_open,
    tiktok_set_bounds, tiktok_set_glass, window_app};

mod voice;
use voice::{install_bin_finalize, install_model_finalize, install_piper_bin, install_tts_voice_part, 
tts_remove_voice, tts_speak, tts_status, voice_download, voice_remove_all, voice_remove_model,
    voice_status, voice_transcribe};

mod git;
use git::{git_commit, git_diff, git_diff_stat, git_discard, git_fetch, git_log, git_pull, git_push, git_stage, git_status, git_unstage};

mod pty;
use pty::{kill_all as pty_kill_all, pty_kill, pty_resize, pty_spawn, pty_write, PtyState};

mod terminals;
use terminals::list_terminals;

mod discord;
use discord::{
    discord_clear, discord_close, discord_get_start_ts, discord_set, discord_status, DiscordState,
};

mod update;
use update::{apply_on_exit, build_flavor, update_download, update_install, update_stage_local};

mod autostart;
use autostart::{autostart_disable, autostart_enable, autostart_is_enabled};

struct ServerState {
    port: u16,
    child: Mutex<Option<Child>>,
    error: Option<String>,
}

// Windows Job Object: child dies with parent even on crash (KILL_ON_JOB_CLOSE).
// Without it a hard renderer crash orphans opencode.exe on its port.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}
    static JOB: OnceLock<JobHandle> = OnceLock::new();

    fn get() -> Option<HANDLE> {
        if let Some(h) = JOB.get() {
            return Some(h.0);
        }
        unsafe {
            let h = CreateJobObjectW(None, None).ok()?;
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // BREAKAWAY_OK allows nested jobs (enterprise/debugger already in a job) to
            // still create a child job; without it AssignProcessToJobObject fails with
            // ERROR_ACCESS_DENIED and nested grandchildren outlive the GUI.
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let _ = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            );
            let _ = JOB.set(JobHandle(h));
            Some(h)
        }
    }

    pub fn assign(child: &Child) {
        let Some(job) = get() else { return };
        unsafe {
            let proc = GetCurrentProcess();
            // ensure current process is also in the job so nested children are covered
            if let Err(e) = AssignProcessToJobObject(job, proc) {
                // ERROR_ACCESS_DENIED means we're already in a job (enterprise policy / debugger)
                // — log instead of silently ignoring; child is still assigned but grandchildren may survive
                eprintln!("[job] AssignProcessToJobObject(current) failed: {} (already in job? nested children may outlive GUI)", e);
            }
            let h = HANDLE(child.as_raw_handle() as *mut _);
            if let Err(e) = AssignProcessToJobObject(job, h) {
                eprintln!("[job] AssignProcessToJobObject(child) failed: {}", e);
            }
        }
    }
}
#[cfg(not(windows))]
mod job {
    use std::process::Child;
    pub fn assign(_: &Child) {}
}

// workspace persistence — saved per local dev build so debug restarts reopen
// the same project without relying on WebView localStorage (devUrl origin
// differs from release, so localStorage would appear empty).
fn workspace_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("workspace"))
}

#[tauri::command]
fn workspace_get(app: tauri::AppHandle) -> String {
    workspace_file(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[tauri::command]
fn workspace_set(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let Some(file) = workspace_file(&app) else {
        return Err("no config dir".into());
    };
    let t = path.trim();
    if t.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, t).map_err(|e| e.to_string())
}

fn read_saved_workspace(app: &tauri::AppHandle) -> Option<PathBuf> {
    let raw = workspace_get(app.clone());
    if raw.is_empty() {
        return None;
    }
    let p = PathBuf::from(raw);
    if p.is_dir() { Some(p) } else { None }
}

fn resolve_opencode_exe(exe_dir: &std::path::Path) -> PathBuf {
    // bundled sidecar next to the GUI exe (release MSI) or dev triple-suffixed name
    for name in ["opencode.exe", "opencode-x86_64-pc-windows-msvc.exe"] {
        let p = exe_dir.join(name);
        if p.is_file() {
            eprintln!("[opencode] resolved sidecar: {}", p.display());
            return p;
        }
    }
    // dev: exe is target/debug/opencode-gui.exe, sidecar lives in src-tauri/binaries
    // walk up to filesystem root (EH-08: previous 4-ancestor cap could miss + fallback to stale PATH)
    if let Ok(cur) = std::env::current_exe() {
        let mut anc = cur.parent().map(|p| p.to_owned());
        loop {
            let Some(dir) = anc.clone() else { break };
            let cand = dir.join("src-tauri").join("binaries").join("opencode-x86_64-pc-windows-msvc.exe");
            if cand.is_file() {
                eprintln!("[opencode] resolved sidecar: {}", cand.display());
                return cand;
            }
            let cand2 = dir.join("binaries").join("opencode.exe");
            if cand2.is_file() {
                eprintln!("[opencode] resolved sidecar: {}", cand2.display());
                return cand2;
            }
            let parent = dir.parent().map(|p| p.to_owned());
            if parent.is_none() || parent == anc {
                break;
            }
            anc = parent;
        }
    }
    // last resort: PATH lookup
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("opencode.exe");
            if p.is_file() {
                eprintln!("[opencode] resolved sidecar via PATH: {}", p.display());
                return p;
            }
            #[cfg(windows)]
            {
                let p2 = dir.join("opencode.cmd");
                if p2.is_file() {
                    eprintln!("[opencode] resolved sidecar via PATH: {}", p2.display());
                    return p2;
                }
            }
        }
    }
    let fallback = exe_dir.join("opencode.exe");
    eprintln!("[opencode] resolved sidecar fallback: {}", fallback.display());
    fallback
}

fn wait_for_port(port: u16, timeout: std::time::Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Instant;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(400)));
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(400)));
            let req = format!(
                "GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 8192];
                if let Ok(n) = stream.read(&mut buf) {
                    if n > 0 {
                        let resp = String::from_utf8_lossy(&buf[..n]);
                        // EH-07: validate HTTP 200 + JSON payload, not just TCP connect (port-steal race)
                        if resp.contains("200") && resp.contains('{') {
                            std::thread::sleep(std::time::Duration::from_millis(80));
                            return true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

fn spawn_server(workspace: Option<PathBuf>) -> std::io::Result<(Child, u16)> {
    const RETRIES: u32 = 5;
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "exe has no parent"))?
        .to_owned();
    let exe_path = resolve_opencode_exe(&exe_dir);
    let home = std::env::var("USERPROFILE").unwrap_or_default();

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..RETRIES {
        let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let mut cmd = Command::new(&exe_path);
        cmd.args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"]);
        if let Some(ref ws) = workspace {
            if ws.is_dir() {
                cmd.current_dir(ws);
            } else if !home.is_empty() {
                cmd.current_dir(&home);
            }
        } else if !home.is_empty() {
            cmd.current_dir(&home);
        }
        #[cfg(debug_assertions)]
        let _ = cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        #[cfg(all(windows, not(debug_assertions)))]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < RETRIES { std::thread::sleep(std::time::Duration::from_millis(200)); continue; }
                else { break; }
            }
        };
        job::assign(&child);

        // wait until the server is actually listening; catches port races
        // where the child fails to bind (port taken) and exits early
        let listening = wait_for_port(port, std::time::Duration::from_secs(8));
        // if child died immediately, it's a bind failure — retry on next port
        match child.try_wait() {
            Ok(Some(status)) => {
                last_err = Some(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("opencode exited early on port {port}: {status}"),
                ));
                if attempt + 1 < RETRIES {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                } else { break; }
            }
            Ok(None) if !listening => {
                // still not listening but child alive — could be slow start; give it a bit more
                if wait_for_port(port, std::time::Duration::from_secs(3)) {
                    return Ok((child, port));
                }
                let _ = child.kill();
                let _ = child.wait();
                last_err = Some(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("opencode not listening on port {port}"),
                ));
                if attempt + 1 < RETRIES { std::thread::sleep(std::time::Duration::from_millis(300)); continue; }
                else { break; }
            }
            Ok(None) => return Ok((child, port)),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < RETRIES { std::thread::sleep(std::time::Duration::from_millis(200)); continue; }
                else { break; }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "failed to start opencode after retries")))
}

#[tauri::command]
fn server_url(state: State<'_, ServerState>) -> Result<String, String> {
    match state.error {
        Some(ref e) => Err(e.clone()),
        None => Ok(format!("http://127.0.0.1:{}", state.port)),
    }
}

// whether the OS glass layer (Mica) was applied — false means the frontend
// must paint an opaque base (no-glass build, or Mica unavailable)
static GLASS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn os_glass() -> bool {
    GLASS.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(all(windows, not(feature = "noglass")))]
fn apply_glass(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    // replicate the pre-split look exactly: the old config-level
    // ["acrylic", "mica"] resolved to Acrylic (first match wins in tauri's
    // vibrancy code), applied with no tint. Acrylic drags badly only on
    // Win10 v1903+ / early Win11 builds — that's what the noglass build
    // avoids.
    if window_vibrancy::apply_acrylic(&w, None).is_ok() {
        GLASS.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(any(not(windows), feature = "noglass"))]
fn apply_glass(_app: &tauri::AppHandle) {}

// theme config: ~/.config/.opencode-gui/themes.json Ã¢â‚¬â€ read by the frontend,
// seeded once by it, and watched here so edits hot-reload the UI
fn themes_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home).join(".config").join(".opencode-gui")
}

fn plugins_dir() -> PathBuf {
    themes_dir().join("plugins")
}

// one folder per plugin under plugins/: plugin.json + main.js (+ styles.css).
// Raw file contents only — validation and manifest parsing live frontend-side
#[derive(serde::Serialize)]
struct PluginDir {
    dir: String,
    manifest: String,
    main: String,
    css: String,
}

#[tauri::command]
fn plugins_scan() -> Vec<PluginDir> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(plugins_dir()) else {
        return out;
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let read = |name: &str| std::fs::read_to_string(e.path().join(name)).unwrap_or_default();
        out.push(PluginDir {
            dir: e.file_name().to_string_lossy().into_owned(),
            manifest: read("plugin.json"),
            main: read("main.js"),
            css: read("styles.css"),
        });
    }
    out
}

// generic https fetch for plugins (signing etc. happens JS-side) — plain
// request/response envelope, no cookies, 10s timeout.
// Public http is blocked; private LAN http (Hue bridge etc.) is allowed.
#[tauri::command]
async fn http_json(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let is_https = url.starts_with("https://");
    let is_private_http = url.starts_with("http://192.168.")
        || url.starts_with("http://10.")
        || url.starts_with("http://172.16.")
        || url.starts_with("http://172.17.")
        || url.starts_with("http://172.18.")
        || url.starts_with("http://172.19.")
        || url.starts_with("http://172.20.")
        || url.starts_with("http://172.21.")
        || url.starts_with("http://172.22.")
        || url.starts_with("http://172.23.")
        || url.starts_with("http://172.24.")
        || url.starts_with("http://172.25.")
        || url.starts_with("http://172.26.")
        || url.starts_with("http://172.27.")
        || url.starts_with("http://172.28.")
        || url.starts_with("http://172.29.")
        || url.starts_with("http://172.30.")
        || url.starts_with("http://172.31.")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost");
    if !(is_https || is_private_http) {
        return Err("only https:// and private http:// (Hue LAN) urls are allowed".into());
    }
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        let has_ct = headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"));
        // Don't default to application/json for empty bodies (411 Length Required on Spotify PUT/POST with no body)
        if !has_ct && !b.is_empty() {
            req = req.header("Content-Type", "application/json");
        }
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| format!("unreachable: {e}"))?;
    let status = resp.status().as_u16();
    // pagination links (HuggingFace tree API et al.) travel in Link headers —
    // must be read before .text() consumes the response
    let link = resp
        .headers()
        .get("link")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": text, "link": link, "retryAfter": retry_after }))
}

#[tauri::command]
fn theme_config_read() -> Result<String, String> {
    let p = themes_dir().join("themes.json");
    if !p.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

// save edited workspace files from the centered file viewer — the opencode
// server API is read-only for files, so writes go through the Tauri host
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_create(path: String, is_dir: bool) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
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
fn file_delete(path: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err("not found".into()); }
    if p.is_dir() { std::fs::remove_dir_all(p).map_err(|e| e.to_string()) } else { std::fs::remove_file(p).map_err(|e| e.to_string()) }
}

#[tauri::command]
fn file_rename(from: String, to: String) -> Result<(), String> {
    if from.trim().is_empty() || to.trim().is_empty() { return Err("empty path".into()); }
    if std::path::Path::new(&to).exists() { return Err("target exists".into()); }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_duplicate(path: String) -> Result<String, String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
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
fn file_reveal(path: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    let p = std::path::Path::new(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if p.is_dir() {
            std::process::Command::new("explorer")
                .arg(&path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn().map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(&path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn().map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(windows))]
    {
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn file_open(path: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("empty path".into()); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd").args(["/C", "start", "", &path]).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn theme_config_write(content: String) -> Result<(), String> {
    let dir = themes_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("themes.json"), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_config_dir() -> Result<(), String> {
    let dir = themes_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn workspace_is_dir(path: String) -> bool {
    let p = std::path::Path::new(path.trim());
    p.is_dir()
}

#[tauri::command]
fn reveal_plugins_dir() -> Result<(), String> {
    let dir = plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn plugin_remove(dir: String) -> Result<(), String> {
    let name = dir.trim().to_string();
    if name.is_empty() {
        return Err("empty plugin name".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(':') {
        return Err("invalid plugin name".into());
    }
    let target = plugins_dir().join(&name);
    if !target.exists() {
        return Err("plugin not found".into());
    }
    // ensure target is still inside plugins_dir (prevent traversal)
    let canon_plugins = plugins_dir().canonicalize().unwrap_or_else(|_| plugins_dir());
    let canon_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_plugins) {
        return Err("invalid plugin path".into());
    }
    std::fs::remove_dir_all(&canon_target).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn plugin_install_files(dir: String, manifest: String, main: String, css: String) -> Result<(), String> {
    let name = dir.trim().to_string();
    if name.is_empty() {
        return Err("empty plugin name".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(':') {
        return Err("invalid plugin name".into());
    }
    if manifest.trim().is_empty() {
        return Err("missing plugin.json".into());
    }
    if main.trim().is_empty() {
        return Err("missing main.js".into());
    }
    // validate manifest is JSON with fallback handling done frontend-side
    serde_json::from_str::<serde_json::Value>(&manifest).map_err(|e| format!("bad plugin.json: {e}"))?;
    let target = plugins_dir().join(&name);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    // ensure still inside plugins_dir
    let canon_plugins = plugins_dir().canonicalize().unwrap_or_else(|_| plugins_dir());
    let canon_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_plugins) {
        return Err("invalid plugin path".into());
    }
    std::fs::write(canon_target.join("plugin.json"), manifest).map_err(|e| e.to_string())?;
    std::fs::write(canon_target.join("main.js"), main).map_err(|e| e.to_string())?;
    if css.trim().is_empty() {
        let _ = std::fs::remove_file(canon_target.join("styles.css"));
    } else {
        std::fs::write(canon_target.join("styles.css"), css).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// watch a config dir; coalesce bursts of events into one emit
fn watch_dir(handle: tauri::AppHandle, path: PathBuf, event: &'static str, recursive: bool) {
    use notify::Watcher as _;
    let _ = std::fs::create_dir_all(&path);
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("{event} watcher unavailable: {e}");
            return;
        }
    };
    let mode = if recursive {
        notify::RecursiveMode::Recursive
    } else {
        notify::RecursiveMode::NonRecursive
    };
    if let Err(e) = watcher.watch(&path, mode) {
        eprintln!("{event} watch failed: {e}");
        return;
    }
    // keep the watcher alive for the process lifetime
    std::thread::spawn(move || {
        let _keep = watcher;
        loop {
            if rx.recv().is_err() {
                break;
            }
            // debounce: editors write in several steps
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let _ = rx.try_recv();
            }
            use tauri::Emitter;
            let _ = handle.emit(event, ());
        }
    });
}

// when true (default), reopening the window from the tray snaps it back to
// the default size from tauri.conf.json — restoring a taskbar-minimized
// window never resets. The "Keep window size" setting turns this off.
static TRAY_RESET: AtomicBool = AtomicBool::new(true);

// disk mirror of the "Keep window size" setting — present ⇔ ON. The frontend
// keeps it in sync through set_tray_reset, so a fresh launch (which happens
// BEFORE the webview can report anything) knows whether the window-state
// plugin's size restore must be undone
fn keep_size_flag(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("keep-window-size"))
}

#[tauri::command]
fn set_tray_reset(app: tauri::AppHandle, enabled: bool) {
    TRAY_RESET.store(enabled, Ordering::Relaxed);
    // enabled ⇔ snap-back active ⇔ "Keep window size" is OFF — mirror the
    // preference to disk so the next launch starts at the default size too
    if let Some(path) = keep_size_flag(&app) {
        if enabled {
            let _ = std::fs::remove_file(&path);
        } else {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, b"");
        }
    }
}

// last focused HWND tracking for system-wide hotkeys across multiple instances
fn last_focused_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("last-focused-hwnd"))
}
fn write_last_focused(app: &tauri::AppHandle, hwnd: isize) {
    if let Some(p) = last_focused_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, hwnd.to_string());
    }
}
fn read_last_focused(app: &tauri::AppHandle) -> Option<isize> {
    last_focused_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse().ok())
}

#[cfg(windows)]
fn is_opencode_window(hwnd: isize) -> bool {
    // Cheap check: title must be "OpenCode" (our main window title)
    // Use GetWindowTextW via windows crate
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, IsWindowVisible};
    if hwnd == 0 {
        return false;
    }
    // hidden tray windows are not visible, but foreground check already ensures visible
    // For foreground check, we also want to verify it's an OpenCode window, not just any
    unsafe {
        if IsWindowVisible(windows::Win32::Foundation::HWND(hwnd as *mut _)).as_bool() == false {
            // Still consider hidden? For foreground check, hidden can't be foreground, so false is fine
            // But for is_opencode check, we still want to compare title even if hidden? Not needed
        }
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(windows::Win32::Foundation::HWND(hwnd as *mut _), &mut buf);
        if len == 0 {
            return false;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        title == "OpenCode"
    }
}

#[cfg(windows)]
fn send_ipc_to_hwnd(hwnd: isize, dw_data: usize) -> bool {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_COPYDATA};
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let cds = COPYDATASTRUCT {
            dwData: dw_data,
            cbData: 0,
            lpData: std::ptr::null_mut(),
        };
        let res = SendMessageW(
            HWND(hwnd as *mut _),
            WM_COPYDATA,
            WPARAM(0),
            LPARAM(&cds as *const _ as isize),
        );
        res.0 != 0
    }
}

#[cfg(windows)]
const IPC_TOGGLE: usize = 0x4F4347; // "OCG"
#[cfg(windows)]
const IPC_MIC: usize = 0x4F434D; // "OCM"
#[cfg(windows)]
const IPC_SHOW: usize = 0x4F4353; // "OCS" for explicit show (not toggle)

#[cfg(windows)]
mod ipc_hook {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC, WM_COPYDATA,
    };
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;

    static IPC_APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    static ORIGINAL_PROC: AtomicIsize = AtomicIsize::new(0);

    pub fn set_app(app: tauri::AppHandle) {
        let m = IPC_APP.get_or_init(|| Mutex::new(None));
        *m.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_COPYDATA {
            let cds = &*(lparam.0 as *const COPYDATASTRUCT);
            let app_opt = IPC_APP.get().and_then(|m| m.lock().unwrap_or_else(|e| e.into_inner()).clone());
            if let Some(app) = app_opt {
                match cds.dwData as usize {
                    super::IPC_TOGGLE => {
                        let app2 = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            // toggle logic matching global shortcut: hide if visible+focused else show
                            if let Some(w) = app2.get_webview_window("main") {
                                let visible = w.is_visible().unwrap_or(false);
                                let focused = super::window_focused(&w);
                                if visible && focused {
                                    super::hide_main(&app2);
                                } else {
                                    super::show_main(&app2);
                                }
                            }
                        });
                        return LRESULT(1);
                    }
                    super::IPC_MIC => {
                        use tauri::Emitter;
                        let _ = app.emit("mic://toggle", ());
                        return LRESULT(1);
                    }
                    super::IPC_SHOW => {
                        let app2 = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            super::show_main(&app2);
                        });
                        return LRESULT(1);
                    }
                    _ => {}
                }
            }
        }
        let orig = ORIGINAL_PROC.load(Ordering::Relaxed);
        if orig != 0 {
            CallWindowProcW(
                std::mem::transmute::<isize, windows::Win32::UI::WindowsAndMessaging::WNDPROC>(orig),
                hwnd,
                msg,
                wparam,
                lparam,
            )
        } else {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }

    pub fn install(app: &tauri::AppHandle) {
        set_app(app.clone());
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(hwnd) = w.hwnd() {
                unsafe {
                    let hwnd_raw = HWND(hwnd.0);
                    let orig = GetWindowLongPtrW(hwnd_raw, GWLP_WNDPROC);
                    ORIGINAL_PROC.store(orig, Ordering::Relaxed);
                    SetWindowLongPtrW(hwnd_raw, GWLP_WNDPROC, wndproc as *const () as usize as isize);
                }
            }
        }
    }
}

#[tauri::command]
fn spawn_new_instance() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("spawn_new_instance: current_exe failed: {e}");
            debug_log(format!("spawn_new_instance current_exe failed: {e}"));
            return;
        }
    };
    let mut cmd = Command::new(&exe);
    cmd.arg("--new-instance");
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(_) => {
            debug_log(format!("spawn_new_instance ok: {}", exe.display()));
        }
        Err(e) => {
            eprintln!("spawn_new_instance spawn failed: {e}");
            debug_log(format!("spawn_new_instance spawn failed: {e}"));
        }
    }
}

#[cfg(windows)]
fn apply_jumplist(_app: &tauri::AppHandle) {
    // JumpList for the pinned taskbar icon: adds "Open new window" and "Quit"
    // via Tasks. Uses jumplist_win (thin wrapper over windows::Win32::UI::Shell).
    // Failure is non-fatal — tray menu remains the fallback.
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => return,
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        // Ensure COM is initialized on the calling thread; harmless if already done.
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
        use jumplist_win::{JumpList, JumpListCategoryCustom, JumpListCategoryType, JumpListItemLink};
        // Use Task category so entries appear under "Tasks" in JumpList.
        let mut jl = JumpList::new();
        let mut task_cat = JumpListCategoryCustom::new(JumpListCategoryType::Task, None);
        task_cat.jump_list_category.set_visible(true);

        // Open new window — launches with --new-instance to bypass single-instance mutex.
        let new_link = JumpListItemLink::new(
            Some(vec!["--new-instance".to_string()]),
            "Open new window".to_string(),
            Some(exe.clone()),
            Some(exe.clone()),
            0,
        );
        task_cat.jump_list_category.items.push(Box::new(new_link));

        // Quit — launches with --quit which the primary handles via single-instance callback.
        let quit_link = JumpListItemLink::new(
            Some(vec!["--quit".to_string()]),
            "Quit OpenCode".to_string(),
            Some(exe.clone()),
            Some(exe.clone()),
            0,
        );
        task_cat.jump_list_category.items.push(Box::new(quit_link));

        jl.add_category(task_cat);
        jl.update();
    }));
}

#[cfg(not(windows))]
fn apply_jumplist(_app: &tauri::AppHandle) {}

// logical width/height of the main window as declared in tauri.conf.json —
// the single source of truth for the tray-reopen reset
fn default_size(app: &tauri::AppHandle) -> (f64, f64) {
    app.config()
        .app
        .windows
        .iter()
        .find(|c| c.label == "main")
        .map(|c| (c.width, c.height))
        .unwrap_or((1100.0, 720.0))
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        unpoison_input(app);
    }
    use tauri::Emitter;
    let _ = app.emit("visibility://changed", true);
}

// minimal user32 surface for the input repair below (user32 is already
// linked by the tao/webview stack — no extra crate needed)
#[cfg(windows)]
mod wininput {
    use std::sync::atomic::{AtomicI32, Ordering};

    #[repr(C)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }
    extern "system" {
        pub fn GetCursorPos(pt: *mut Point) -> i32;
        pub fn ScreenToClient(hwnd: isize, pt: *mut Point) -> i32;
        pub fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
        pub fn EnumChildWindows(
            hwnd: isize,
            cb: unsafe extern "system" fn(isize, isize) -> i32,
            lparam: isize,
        ) -> i32;
        pub fn SendInput(count: u32, inputs: *mut Input, size: i32) -> u32;
        pub fn SetFocus(hwnd: isize) -> isize;
        pub fn SetForegroundWindow(hwnd: isize) -> i32;
        pub fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
        pub fn IsWindowVisible(hwnd: isize) -> i32;
    }

    // cursor position shared with the EnumChildWindows callbacks — a plain
    // extern fn can't capture anything, so it reads these instead
    pub static CUR_X: AtomicI32 = AtomicI32::new(0);
    pub static CUR_Y: AtomicI32 = AtomicI32::new(0);

    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_CANCELMODE: u32 = 0x001F;

    // forward the current cursor position to one child HWND so Chromium's
    // hover tracking re-registers (TrackMouseEvent) and :hover recomputes
    pub unsafe extern "system" fn pump_mousemove(child: isize, _lp: isize) -> i32 {
        let mut pt = Point {
            x: CUR_X.load(Ordering::Relaxed),
            y: CUR_Y.load(Ordering::Relaxed),
        };
        ScreenToClient(child, &mut pt);
        let lp = (((pt.y as u16 as usize) << 16) | (pt.x as u16 as usize)) as isize;
        PostMessageW(child, WM_MOUSEMOVE, 0, lp);
        1
    }

    // tell one child HWND to drop any stuck mouse capture / modal input loop.
    // Unlike ReleaseCapture — which only reaches OUR thread — a posted
    // WM_CANCELMODE crosses into the webview process where the stale state
    // actually lives
    pub unsafe extern "system" fn pump_cancelmode(child: isize, _lp: isize) -> i32 {
        PostMessageW(child, WM_CANCELMODE, 0, 0);
        1
    }

    // INPUT/MOUSEINPUT mirror (x64 layout: type + pad + 32-byte MOUSEINPUT)
    #[repr(C)]
    pub struct MouseInput {
        pub dx: i32,
        pub dy: i32,
        pub mouse_data: u32,
        pub dw_flags: u32,
        pub time: u32,
        pub extra_info: usize,
    }
    #[repr(C)]
    pub struct Input {
        pub kind: u32,
        pub pad: u32,
        pub union: MouseInput,
    }

    const INPUT_MOUSE: u32 = 0;
    const MOUSEEVENTF_MOVE: u32 = 0x0001;

    // two REAL relative moves (+1px then -1px) injected through the OS input
    // pipeline. This is what actually clears Chromium's stuck mouse state —
    // genuine WM_MOUSEMOVEs re-run its hit testing and TrackMouseEvent, the
    // same effect as the repairing click users had to perform manually
    pub fn wiggle_cursor() -> bool {
        let mut inputs: [Input; 2] = [
            Input { kind: INPUT_MOUSE, pad: 0, union: MouseInput { dx: 1, dy: 0, mouse_data: 0, dw_flags: MOUSEEVENTF_MOVE, time: 0, extra_info: 0 } },
            Input { kind: INPUT_MOUSE, pad: 0, union: MouseInput { dx: -1, dy: 0, mouse_data: 0, dw_flags: MOUSEEVENTF_MOVE, time: 0, extra_info: 0 } },
        ];
        unsafe {
            SendInput(2, inputs.as_mut_ptr(), std::mem::size_of::<Input>() as i32) == 2
        }
    }

    // focus the WebView2 child HWND directly — SetFocus on the top-level HWND
    // alone doesn't route WM_KEYDOWN into the Chromium process after a
    // hide/show or Alt+Tab cycle. Walk descendants and SetFocus the first
    // Chrome_WidgetWin* (the real webview content host).
    pub unsafe extern "system" fn focus_webview_child(child: isize, _lp: isize) -> i32 {
        // recurse first so deepest Chrome_WidgetWin wins (it is the actual content)
        EnumChildWindows(child, focus_webview_child, 0);
        let mut buf = [0u16; 256];
        let len = GetClassNameW(child, buf.as_mut_ptr(), 256);
        if len > 0 {
            // cheap check: Chrome_WidgetWin* starts with 'C' (67) — avoid alloc if not
            if buf[0] == 67 {
                let name = String::from_utf16_lossy(&buf[..len as usize]);
                if name.starts_with("Chrome_WidgetWin") {
                    // only visible webview should steal focus
                    if IsWindowVisible(child) != 0 {
                        SetFocus(child);
                    }
                }
            }
        }
        1
    }

    pub fn focus_webview(hwnd_main: isize) {
        unsafe {
            SetForegroundWindow(hwnd_main);
            SetFocus(hwnd_main);
            EnumChildWindows(hwnd_main, focus_webview_child, 0);
        }
    }
}

// Hiding + reshowing the window leaves WebView2's input pipeline stuck:
// the webview process keeps a stale mouse capture and never sees a mouse
// ENTER again, so real moves/wheel/hover are swallowed until a real click.
// Repair after every show, in escalating force:
//   1. WM_CANCELMODE to every descendant HWND — drops the stuck capture
//      inside the webview process (cross-process, unlike ReleaseCapture)
//   2. posted WM_MOUSEMOVEs — nudge hover tracking as a cheap first pass
//   3. a REAL SendInput cursor wiggle (+1px/-1px) — genuine OS-level moves
//      that re-run Chromium's hit testing, equivalent to the repairing click
//   4. delayed SetForegroundWindow/SetFocus retries — WebView2 keyboard input
//      stays dead until the HWND truly owns foreground; the first set_focus
//      can land before show() settles (Alt+Space) or not at all (Alt+Tab).
#[cfg(windows)]
fn unpoison_input(app: &tauri::AppHandle) {
    let hwnd = match app.get_webview_window("main").map(|w| w.hwnd()) {
        Some(Ok(h)) => h.0 as isize,
        _ => return,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        // let the show settle before poking at input state
        std::thread::sleep(std::time::Duration::from_millis(60));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            // ensure OS focus — first retry (covers show() settling) + direct
            // WebView child focus. w.set_focus() alone leaves WM_KEYDOWN stuck
            // on the outer HWND until a click.
            if let Some(w) = app2.get_webview_window("main") {
                if !window_focused(&w) {
                    let _ = w.set_focus();
                }
            }
            use wininput::*;
            // focus deepest Chrome_WidgetWin so keyboard goes to Chromium
            focus_webview(hwnd);
            EnumChildWindows(hwnd, pump_cancelmode, 0);
            let mut pt = Point { x: 0, y: 0 };
            if GetCursorPos(&mut pt) != 0 {
                CUR_X.store(pt.x, Ordering::Relaxed);
                CUR_Y.store(pt.y, Ordering::Relaxed);
                EnumChildWindows(hwnd, pump_mousemove, 0);
            }
        });
        // tell frontend to re-assert DOM focus (composer textarea → body fallback)
        let _ = app.emit("focus://restore", ());
        // real events through the OS input pipeline — the part that
        // actually clears the webview's stuck state; needs no main thread
        std::thread::sleep(std::time::Duration::from_millis(30));
        if wininput::wiggle_cursor() {
            let _ = app.run_on_main_thread(move || unsafe {
                use wininput::*;
                EnumChildWindows(hwnd, pump_mousemove, 0);
            });
        }
        // second focus retry — by now the window is definitely visible; if we
        // still don't own foreground (Alt+Space race) force it once more so
        // WebView2 delivers WM_KEYDOWN to its child without needing a click
        std::thread::sleep(std::time::Duration::from_millis(70));
        let app3 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app3.get_webview_window("main") {
                if !window_focused(&w) {
                    let _ = w.set_focus();
                } else {
                    // even when focused, a second set_focus nudges WebView2's
                    // internal focus from the outer HWND to the webview child
                    // in cases where mouse capture was stuck
                    let _ = w.set_focus();
                }
            }
            // ensure child still owns keyboard focus after the wiggle
            wininput::focus_webview(hwnd);
        });
        let _ = app.emit("focus://restore", ());
        // final JS-level focus via eval fallback (in case frontend hasn't mounted
        // its listener yet — e.g. first show during setup)
        std::thread::sleep(std::time::Duration::from_millis(30));
        let app4 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app4.get_webview_window("main") {
                let _ = w.eval(
                    "setTimeout(()=>{ try{ window.focus(); var a=document.activeElement; if(!a||a===document.body){ var isTerm=!!window.__oc_lastWasTerm; var term=document.querySelector('.term-dock:not(.closed) .xterm-helper-textarea'); var comp=document.querySelector('.composer textarea'); var f=(isTerm&&term)?term:(comp||term||document.querySelector('.fe-ta')||document.body); if(f){ if(!f.hasAttribute('tabindex')&&f===document.body) f.setAttribute('tabindex','-1'); f.focus({preventScroll:true}); } } else { try{a.focus({preventScroll:true});}catch(e){} } window.focus(); }catch(e){} }, 0)",
                );
            }
        });
    });
}

#[cfg(not(windows))]
fn unpoison_input(_app: &tauri::AppHandle) {}

// Alt+Tab / taskbar / tray reactivation leaves keyboard input dead until a
// click. Root cause (tauri#15624): with the `unstable` feature the main
// webview is built as a child webview, so wry never attaches its parent
// subclass (WM_SETFOCUS -> MoveFocus) — and on reactivation focus can land
// directly on the WebView2 child HWND, so the top-level never sees
// WM_SETFOCUS and no repair runs. Fixed upstream in tauri#15625 / wry#1755,
// not yet released (tauri 2.11.5 is current) — this is that fix, app-side:
// subclass the top-level for WM_ACTIVATE and re-seed the controller with
// MoveFocus(PROGRAMMATIC). The MoveFocus must be DEFERRED via a posted
// message: issued synchronously inside WM_ACTIVATE it gets overwritten when
// Windows subsequently restores focus to the webview child. WA_INACTIVE is
// skipped so only activation edges re-seed; the posted message cannot
// re-enter WM_ACTIVATE, so no focus loop.
#[cfg(windows)]
mod webfocus {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    };

    const WM_ACTIVATE: u32 = 0x0006;
    const WA_INACTIVE: u16 = 0;
    // WM_APP range — nothing else in this app uses it for the main window
    const MSG_REFOCUS: u32 = 0x8000 + 0x5043; // WM_APP + 'PC'
    const SUBCLASS_ID: usize = 0x0C47; // 'OC'

    type LRESULT = isize;
    type SubclassProc = unsafe extern "system" fn(
        hwnd: isize,
        msg: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> LRESULT;

    extern "system" {
        fn SetWindowSubclass(hwnd: isize, proc: SubclassProc, id: usize, data: usize) -> i32;
        fn DefSubclassProc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> LRESULT;
        fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    }

    unsafe extern "system" fn proc(
        hwnd: isize,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        if msg == WM_ACTIVATE {
            // let normal activation routing run first...
            let r = DefSubclassProc(hwnd, msg, wparam, lparam);
            if (wparam as u16) != WA_INACTIVE {
                // immediate child focus attempt — the deferred MoveFocus alone is
                // one message loop late, so the very first keydown after Alt+Tab
                // would hit the outer HWND, be swallowed and cause a Windows beep.
                // Best-effort synchronous SetFocus on the Chrome_WidgetWin child
                // plus the deferred MoveFocus covers both immediate and settled.
                let _ = std::panic::catch_unwind(|| {
                    super::wininput::focus_webview(hwnd);
                });
                PostMessageW(hwnd, MSG_REFOCUS, 0, 0);
            }
            return r;
        }
        if msg == MSG_REFOCUS {
            let controller = data as *mut ICoreWebView2Controller;
            if !controller.is_null() {
                let _ = (*controller).MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    // attach on the main thread once the main window exists; the controller
    // is handed to the subclass and lives as long as the window
    pub fn install(window: &tauri::WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let h = hwnd.0 as isize;
        let _ = window.with_webview(move |wv| {
            let data = Box::into_raw(Box::new(wv.controller())) as usize;
            unsafe {
                SetWindowSubclass(h, proc, SUBCLASS_ID, data);
            }
        });
    }
}

// snap the main window back to the size declared in tauri.conf.json — shared
// by the tray-reopen reset and the launch reset ("Keep window size" off)
fn apply_default_size(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // never shrink a window carrying the maximized flag without clearing
        // it first — parent/webview geometry desyncs and hovers go dead
        // until the next click
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        }
        let (width, height) = default_size(app);
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
    }
}

fn hide_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // hide FIRST, then resize while invisible: a programmatic set_size
        // on a visible window is what poisons WebView2's input pipeline.
        // The reopen still lands at the default size — same end state as
        // the old pre-hide resize, minus the poisoning
        let _ = w.hide();
        if TRAY_RESET.load(Ordering::Relaxed) {
            apply_default_size(app);
        }
    }
    use tauri::Emitter;
    let _ = app.emit("visibility://changed", false);
}

// visibility-only toggle shared by the tray icon click and the tray menu —
// unlike Alt+Space there is no focus check: both are explicit user intents
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            hide_main(app);
        } else {
            show_main(app);
        }
    }
}

// frontend entry point for hide-to-tray (titlebar X button) — goes through
// hide_main so the pre-hide size reset applies on every path to the tray
#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    hide_main(&app);
}

#[tauri::command]
fn toggle_window(app: tauri::AppHandle) {
    toggle_main(&app);
}

// ground-truth focus check for the Alt+Space toggle: after an interactive
// resize, tao's internal focus tracking desyncs and is_focused() reports
// false until a hide/minimize cycle resets it — making the hotkey take the
// "show" branch on an already-visible window. Ask user32 directly instead.
#[cfg(windows)]
fn window_focused(win: &tauri::WebviewWindow) -> bool {
    // user32 is already linked by the tao/webview stack; GetForegroundWindow
    // always returns a top-level HWND, so plain equality with the main
    // window's handle covers child-webview focus too
    extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
    }
    match win.hwnd() {
        Ok(h) => {
            let fg = unsafe { GetForegroundWindow() };
            fg == h.0
        }
        Err(_) => win.is_focused().unwrap_or(false),
    }
}

#[cfg(not(windows))]
fn window_focused(win: &tauri::WebviewWindow) -> bool {
    win.is_focused().unwrap_or(false)
}

// TEMP diagnostics — appends frontend errors to %TEMP%\oc-gui-debug.log so
// they survive a hard renderer crash (remove once the crash is fixed)
#[tauri::command]
fn debug_log(msg: String) {
    use std::io::Write;
    let path = std::env::temp_dir().join("oc-gui-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

// Sidebar drag/hover cursor must match the user's live Windows pointer scheme
// (custom schemes included). WebView2 ignores the scheme for CSS cursors and
// paints stock bitmaps, so pull the real IDC_SIZEWE handle, pack it into a
// .cur file and ship it to the DOM as a data URL. None → frontend keeps its
// bundled fallback.
#[cfg(windows)]
fn b64(d: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((d.len() + 2) / 3 * 4);
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

#[cfg(windows)]
#[tauri::command]
fn resize_cursor() -> Option<serde_json::Value> {
    #[repr(C)]
    struct IconInfo {
        f_icon: i32,
        x_hotspot: u32,
        y_hotspot: u32,
        hbm_mask: isize,
        hbm_color: isize,
    }
    #[repr(C)]
    struct Bitmap {
        bm_type: i32,
        bm_width: i32,
        bm_height: i32,
        bm_width_bytes: i32,
        bm_planes: u16,
        bm_bits_pixel: u16,
        bm_bits: isize,
    }
    #[repr(C)]
    struct BmiHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }
    #[repr(C)]
    struct Bmi {
        header: BmiHeader,
        colors: [u32; 3],
    }

    extern "system" {
        fn LoadCursorW(hinstance: isize, name: *const u16) -> isize;
        fn GetIconInfo(icon: isize, info: *mut IconInfo) -> i32;
        fn GetObjectW(obj: isize, cb: i32, out: *mut Bitmap) -> i32;
        fn GetDIBits(dc: isize, bmp: isize, start: u32, lines: u32, bits: *mut u8, bmi: *mut Bmi, usage: u32) -> i32;
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, dc: isize) -> i32;
        fn DeleteObject(obj: isize) -> i32;
    }

    unsafe {
        // IDC_SIZEWE — resolves through the active pointer scheme
        let hc = LoadCursorW(0, 32644usize as *const u16);
        if hc == 0 {
            return None;
        }
        let mut ii: IconInfo = std::mem::zeroed();
        if GetIconInfo(hc, &mut ii) == 0 {
            return None;
        }
        let _ = DeleteObject(ii.hbm_color);
        let _ = DeleteObject(ii.hbm_mask);

        // mask bitmap height = color + AND halves, so /2 is the real height
        let mut mbm: Bitmap = std::mem::zeroed();
        if GetObjectW(ii.hbm_mask, std::mem::size_of::<Bitmap>() as i32, &mut mbm) == 0 {
            return None;
        }
        let (w, h) = (mbm.bm_width, mbm.bm_height / 2);
        if w <= 0 || h <= 0 || w > 256 || h > 256 {
            return None;
        }

        let dc = GetDC(0);
        if dc == 0 {
            return None;
        }
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut bmi: Bmi = std::mem::zeroed();
        bmi.header = BmiHeader {
            size: std::mem::size_of::<BmiHeader>() as u32,
            width: w,
            height: -h, // top-down
            planes: 1,
            bit_count: 32,
            compression: 0, // BI_RGB
            size_image: px.len() as u32,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let ok_px =
            GetDIBits(dc, ii.hbm_color, 0, h as u32, px.as_mut_ptr(), &mut bmi, 0) == h;

        let mstride = (((w + 31) / 32) * 4) as usize;
        let mut mask = vec![0u8; mstride * h as usize];
        let mut mbmi: Bmi = std::mem::zeroed();
        mbmi.header = BmiHeader {
            size: std::mem::size_of::<BmiHeader>() as u32,
            width: w,
            height: h,
            planes: 1,
            bit_count: 1,
            compression: 0,
            size_image: mask.len() as u32,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let ok_mask =
            GetDIBits(dc, ii.hbm_mask, 0, h as u32, mask.as_mut_ptr(), &mut mbmi, 0) == h;
        ReleaseDC(0, dc);
        if !ok_px {
            return None;
        }

        // schemes without per-pixel alpha encode transparency in the AND
        // mask — bake it into alpha so one code path serves both
        if !px.chunks_exact(4).any(|p| p[3] != 0) && ok_mask {
            for y in 0..h as usize {
                for x in 0..w as usize {
                    // AND mask rows arrive bottom-up
                    let opaque = (mask[(h as usize - 1 - y) * mstride + x / 8]
                        >> (7 - x % 8))
                        & 1
                        == 0;
                    if opaque {
                        px[(y * w as usize + x) * 4 + 3] = 255;
                    }
                }
            }
        }

        // pack as .cur: ICONDIR + entry + BITMAPINFOHEADER + bottom-up BGRA
        // + all-zero AND mask (alpha now decides everything)
        let mut out = Vec::with_capacity(22 + 40 + px.len() + mask.len());
        out.extend([0u8, 0, 2, 0, 1, 0]); // type 2 = cursor, count 1
        out.extend([w as u8, h as u8, 0, 0]);
        out.extend((ii.x_hotspot as u16).to_le_bytes());
        out.extend((ii.y_hotspot as u16).to_le_bytes());
        out.extend(((40 + px.len() + mask.len()) as u32).to_le_bytes());
        out.extend(22u32.to_le_bytes()); // pixel data offset
        out.extend(40u32.to_le_bytes());
        out.extend(w.to_le_bytes());
        out.extend(((h * 2) as i32).to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(32u16.to_le_bytes());
        out.extend([0u8; 24]); // BI_RGB + sizeimage + ppms + clr fields
        let w4 = (w * 4) as usize;
        for row in (0..h as usize).rev() {
            out.extend_from_slice(&px[row * w4..(row + 1) * w4]);
        }
        out.resize(out.capacity(), 0); // trailing zero AND mask

        Some(serde_json::json!({
            "url": format!("data:image/x-icon;base64,{}", b64(&out)),
            "x": ii.x_hotspot,
            "y": ii.y_hotspot,
        }))
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn resize_cursor() -> Option<serde_json::Value> {
    None
}

fn handle_global_shortcut(
    app: &tauri::AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    // Windows auto-repeats held hotkeys (WM_HOTKEY ~33ms apart after
    // ~500ms hold) — act only on FRESH presses: ones where this key
    // was physically released since its previous press
    use std::sync::Mutex;
    static HELD: Mutex<Option<u32>> = Mutex::new(None);
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    match event.state() {
        tauri_plugin_global_shortcut::ShortcutState::Released => {
            if *held == Some(event.id) {
                *held = None;
            }
            return;
        }
        tauri_plugin_global_shortcut::ShortcutState::Pressed => {
            let prev = held.replace(event.id);
            if prev == Some(event.id) {
                return; // auto-repeat of a key still held down
            }
        }
    }
    drop(held);
    // shortcut.to_string() renders "shift+control+KeyM" style —
    // never equal to the registered spelling, so compare parsed
    let Ok(mic): Result<tauri_plugin_global_shortcut::Shortcut, _> = "ctrl+shift+m".parse() else { return; };
    if *shortcut == mic {
        // mic toggle — forward to last focused instance if different
        #[cfg(windows)]
        {
            let my_hwnd = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);
            let fg = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize
            };
            let target = if fg != 0 && is_opencode_window(fg) {
                Some(fg)
            } else {
                read_last_focused(app)
            };
            if let Some(t) = target {
                if t != my_hwnd && t != 0 && send_ipc_to_hwnd(t, IPC_MIC) {
                    return;
                }
            }
            use tauri::Emitter;
            let _ = app.emit("mic://toggle", ());
        }
        #[cfg(not(windows))]
        {
            use tauri::Emitter;
            let _ = app.emit("mic://toggle", ());
        }
    } else {
        // Alt+Space toggle — apply to last focused instance system-wide
        #[cfg(windows)]
        {
            let my_hwnd = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);
            let fg = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize
            };
            let target = if fg != 0 && is_opencode_window(fg) {
                Some(fg)
            } else {
                read_last_focused(app)
            };
            if let Some(t) = target {
                if t != my_hwnd && t != 0 {
                    if send_ipc_to_hwnd(t, IPC_TOGGLE) {
                        return;
                    }
                    // SendMessage failed (target closed), fallback to self
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let visible = w.is_visible().unwrap_or(false);
                let focused = window_focused(&w);
                if visible && focused {
                    hide_main(app);
                } else {
                    show_main(app);
                }
            }
        }
        #[cfg(not(windows))]
        {
            if let Some(w) = app.get_webview_window("main") {
                let visible = w.is_visible().unwrap_or(false);
                let focused = window_focused(&w);
                if visible && focused {
                    hide_main(app);
                } else {
                    show_main(app);
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // --new-instance bypasses the single-instance mutex so an explicit
    // "Open new window" can spawn a second independent process. All other
    // second launches go through the single-instance callback and restore
    // the existing window (left-click on pinned taskbar).
    let is_new_instance = std::env::args().any(|a| a == "--new-instance");
    let mut builder = tauri::Builder::default()
        // remembers window size/position across launches — but never
        // visibility: the window is created hidden ("visible": false) and
        // shown explicitly in setup once the launch resize has run on it
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // native folder picker for the workspace setting
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    if !is_new_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--new-instance") {
                // Should not happen via normal single-instance path because
                // --new-instance launches bypass registration; handle defensively
                // by spawning a new process anyway.
                spawn_new_instance();
            } else if args.iter().any(|a| a == "--quit") {
                app.exit(0);
            } else {
                // Pinned taskbar left-click: show last focused window system-wide
                #[cfg(windows)]
                {
                    let my_hwnd = app
                        .get_webview_window("main")
                        .and_then(|w| w.hwnd().ok())
                        .map(|h| h.0 as isize)
                        .unwrap_or(0);
                    if let Some(target) = read_last_focused(app) {
                        if target != my_hwnd && target != 0 && send_ipc_to_hwnd(target, IPC_SHOW) {
                            return;
                        }
                    }
                }
                show_main(app);
            }
        }));
    }
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            server_url,
            os_glass,
            workspace_get,
            workspace_set,
            theme_config_read,
            theme_config_write,
            write_file,
            file_create,
            file_delete,
            file_rename,
            file_duplicate,
            file_reveal,
            file_open,
            reveal_config_dir,
            reveal_plugins_dir,
            workspace_is_dir,
            plugin_remove,
            plugin_install_files,
            plugins_scan,
            discord_set,
            discord_get_start_ts,
            discord_clear,
            discord_close,
            discord_status,
            http_json,
            browser_open,
            browser_back,
            browser_forward,
            browser_navigate,
            browser_reload,
            browser_close,
            tiktok_open,
            tiktok_close,
            tiktok_set_bounds,
            tiktok_set_glass,
            tiktok_navigate,
              open_external,
              open_app,
              window_app,
            voice_status,
            voice_transcribe,
            voice_download,
            install_bin_finalize,
            install_model_finalize,
            voice_remove_model,
            tts_status,
            tts_speak,
            install_piper_bin,
            install_tts_voice_part,
            tts_remove_voice,
            voice_remove_all,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_diff,
            git_diff_stat,
            git_log,
            list_terminals,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            update_download,
            update_install,
            update_stage_local,
            build_flavor,
            autostart_is_enabled,
            autostart_enable,
            autostart_disable,
            set_tray_reset,
            hide_to_tray,
            toggle_window,
            spawn_new_instance,
            debug_log,
            resize_cursor,
        ]);

    // global hotkeys, work system-wide. The plugin itself registers nothing;
    // combos are registered per-shortcut in setup() via on_shortcut so a
    // taken combo (second instance, PowerToys Run) only skips that combo —
    // with_shortcuts would abort plugin setup and the app, which is why
    // --new-instance used to skip the plugin entirely, silently leaving the
    // app with NO hotkeys after every auto-update relaunch (update.rs spawns
    // --new-instance while the old owner is already gone).
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .setup(|app| {
            // system tray: left click toggles visibility, right click menu.
            // Both tray and pinned taskbar JumpList expose "Open new window"
            // and "Quit" so the two surfaces stay consistent.
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };
            use tauri_plugin_global_shortcut::GlobalShortcutExt;

            // register global hotkeys one by one: a taken combo (second
            // instance, PowerToys Run) only skips that combo instead of
            // aborting plugin setup
            for combo in ["alt+space", "ctrl+shift+m"] {
                if let Err(e) = app
                    .global_shortcut()
                    .on_shortcut(combo, handle_global_shortcut)
                {
                    eprintln!("global shortcut {combo} unavailable: {e}");
                }
            }

            let show = MenuItem::with_id(app, "show", "Show/Hide OpenCode GUI", true, None::<&str>)?;
            let new_win = MenuItem::with_id(app, "new-instance", "Open new window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            // separator is cosmetic; omit to maximize tray compat (second instance had empty menu with it)
            let menu = Menu::with_items(app, &[&show, &new_win, &quit])?;

            // Build tray icon — don't let a missing icon crash the second instance.
            // Primary and second instance share the same bundle icon, but be defensive.
            let tray_icon = match app.default_window_icon().cloned() {
                Some(icon) => icon,
                None => {
                    debug_log("tray icon missing, aborting tray build (non-fatal)".into());
                    eprintln!("tray icon missing");
                    // still continue setup so window shows; skip tray
                    // we need to still run JumpList and server setup, so don't return Err
                    // Instead, create a dummy 1x1 image to keep tray alive
                    tauri::image::Image::new(&[0, 0, 0, 0], 1, 1)
                }
            };
            // Wrap tray build so a failure doesn't crash the window (second instance race)
            let tray_res: Result<(), String> = (|| {
                TrayIconBuilder::with_id("main")
                    .icon(tray_icon)
                    .tooltip("OpenCode")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => toggle_main(app),
                        "new-instance" => spawn_new_instance(),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            toggle_main(app);
                        }
                    })
                    .build(app)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })();
            if let Err(e) = tray_res {
                debug_log(format!("tray build failed (non-fatal): {e}"));
                eprintln!("tray build failed: {e}");
            }

            // Pinned taskbar JumpList — mirrors tray: "Open new window" + "Quit"
            apply_jumplist(app.handle());

            // don't wait for the sidecar to bind — hand out the URL
            // immediately; the frontend renders on templates and polls
            // silently until the server answers
            // debug local builds restore last workspace as server CWD so
            // file tree works even before the frontend's ?directory= hydrates
            let saved_ws = read_saved_workspace(app.handle());
            let state = match spawn_server(saved_ws) {
                Ok((child, port)) => ServerState {
                    port,
                    child: Mutex::new(Some(child)),
                    error: None,
                },
                Err(e) => ServerState {
                    port: 0,
                    child: Mutex::new(None),
                    error: Some(format!("failed to start opencode serve: {e}")),
                },
            };
            app.manage(state);
            app.manage(browser::BrowserState::default());
            app.manage(browser::FloatingState::default());
            app.manage(PtyState::default());
            app.manage(DiscordState::default());
            update::cleanup_old();
            let h = app.handle().clone();
            watch_dir(h.clone(), themes_dir(), "themes://changed", false);
            watch_dir(h, plugins_dir(), "plugins://changed", true);
            apply_glass(app.handle());
            // the window is created hidden (tauri.conf.json "visible": false)
            // so any launch-time resize happens on an invisible window — a
            // programmatic set_size on a visible one poisons WebView2 input.
            // "Keep window size" OFF (the default): undo the window-state
            // plugin's restore first. The marker file mirrors the setting
            // because the webview hasn't loaded yet — its set_tray_reset
            // sync only lands later
            if !keep_size_flag(app.handle())
                .map(|p| p.exists())
                .unwrap_or(false)
            {
                apply_default_size(app.handle());
            }
            // show + focus + input repair. The explicit focus matters: the
            // first Alt+Space must see "visible and focused" to hide again
            show_main(app.handle());

            #[cfg(windows)]
            {
                // per-instance IPC hook for last-focused hotkey forwarding
                ipc_hook::install(app.handle());
                if let Some(w) = app.handle().get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        write_last_focused(app.handle(), hwnd.0 as isize);
                    }
                    // keyboard-focus repair across reactivation (alt-tab /
                    // taskbar / tray) — see webfocus module docs
                    webfocus::install(&w);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("tauri build failed: {e}");
            std::process::exit(1);
        })
        .run(|_app_handle, event| {
            // track last focused HWND for system-wide hotkeys across multiple
            // instances. Keyboard-focus repair on reactivation lives in the
            // webfocus subclass (WM_ACTIVATE → MoveFocus) — a per-event repair
            // thread here re-activated the window on every Focused edge and
            // fed itself into a focus-stealing loop that crashed the app.
            #[cfg(windows)]
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Focused(focused),
                ..
            } = &event
            {
                if *focused && label == "main" {
                    if let Some(w) = _app_handle.get_webview_window("main") {
                        if let Ok(hwnd) = w.hwnd() {
                            write_last_focused(_app_handle, hwnd.0 as isize);
                        }
                    }
                }
            }
            // keep the browser webview glued below the top bar across
            // window resizes / DPI changes while it is open
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Resized(size),
                ..
            } = &event
            {
                if label == "main" {
                    browser::on_main_resize(_app_handle, *size);
                }
            }
            if let RunEvent::Exit = event {
                if let Some(mut child) = _app_handle
                    .state::<ServerState>()
                    .child
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                {
                    let _ = child.kill();
                    // give the OS a moment to release the port / file lock so
                    // the next launch or the updater's file swap doesn't collide
                    let _ = child.wait();
                }
                // staged update swap + relaunch — after the sidecar is dead
                // so its image file is no longer locked
                apply_on_exit();
                // terminal shells die with the app
                if let Some(state) = _app_handle.try_state::<PtyState>() {
                    pty_kill_all(&state);
                }
                // discord ipc pipe close
                if let Some(state) = _app_handle.try_state::<DiscordState>() {
                    state.shutdown();
                }
            }
        });
}

