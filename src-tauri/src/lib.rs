use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State, WindowEvent};

mod browser;
use browser::{browser_back, browser_close, browser_forward, browser_navigate, browser_open,
    browser_reload, open_app, open_external, window_app};

mod voice;
use voice::{install_bin_finalize, install_model_finalize, install_piper_bin, install_tts_voice_part, 
tts_remove_voice, tts_speak, tts_status, voice_download, voice_remove_all, voice_remove_model,
    voice_status, voice_transcribe};

mod git;
use git::{git_commit, git_diff, git_discard, git_log, git_pull, git_push, git_stage, git_status, git_unstage};

mod pty;
use pty::{pty_kill, pty_resize, pty_spawn, pty_write, PtyState};

mod discord;
use discord::{discord_clear, discord_close, discord_set, discord_status, DiscordState};

mod update;
use update::{apply_on_exit, build_flavor, update_download, update_install};

struct ServerState {
    port: u16,
    child: Mutex<Option<Child>>,
    error: Option<String>,
}

// ponytail: kill-on-exit handler covers normal close; a hard crash can orphan
// the server. Windows Job Objects (KILL_ON_JOB_CLOSE) if that ever matters.
fn spawn_server() -> std::io::Result<(Child, u16)> {    let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let exe_dir = std::env::current_exe()?
        .parent()
        .expect("exe has parent")
        .to_owned();
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let mut cmd = Command::new(exe_dir.join("opencode.exe"));
    cmd.args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"]);
    // ponytail: server reflects any Origin by default (verified), no --cors flags needed
    if !home.is_empty() {
        cmd.current_dir(&home);
    }
    #[cfg(debug_assertions)]
    let _ = cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    // release: null stdio AND CREATE_NO_WINDOW Ã¢â‚¬â€ without the flag a visible
    // console window pops up next to our frameless GUI
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }
    Ok((cmd.spawn()?, port))
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
// request/response envelope, no cookies, 10s timeout
#[tauri::command]
async fn http_json(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    if !url.starts_with("https://") {
        return Err("only https:// urls are allowed".into());
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
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": text, "link": link }))
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
        *m.lock().unwrap() = Some(app);
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_COPYDATA {
            let cds = &*(lparam.0 as *const COPYDATASTRUCT);
            let app_opt = IPC_APP.get().and_then(|m| m.lock().unwrap().clone());
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
#[cfg(windows)]
fn unpoison_input(app: &tauri::AppHandle) {
    let hwnd = match app.get_webview_window("main").map(|w| w.hwnd()) {
        Some(Ok(h)) => h.0 as isize,
        _ => return,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        // let the show settle before poking at input state
        std::thread::sleep(std::time::Duration::from_millis(60));
        let _ = app.run_on_main_thread(move || unsafe {
            use wininput::*;
            EnumChildWindows(hwnd, pump_cancelmode, 0);
            let mut pt = Point { x: 0, y: 0 };
            if GetCursorPos(&mut pt) != 0 {
                CUR_X.store(pt.x, Ordering::Relaxed);
                CUR_Y.store(pt.y, Ordering::Relaxed);
                EnumChildWindows(hwnd, pump_mousemove, 0);
            }
        });
        // real events through the OS input pipeline — the part that
        // actually clears the webview's stuck state; needs no main thread
        std::thread::sleep(std::time::Duration::from_millis(30));
        if wininput::wiggle_cursor() {
            let _ = app.run_on_main_thread(move || unsafe {
                use wininput::*;
                EnumChildWindows(hwnd, pump_mousemove, 0);
            });
        }
    });
}

#[cfg(not(windows))]
fn unpoison_input(_app: &tauri::AppHandle) {}

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
        .plugin(tauri_plugin_dialog::init());
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
            theme_config_read,
            theme_config_write,
            write_file,
            reveal_config_dir,
            reveal_plugins_dir,
            plugin_remove,
            plugin_install_files,
            plugins_scan,
            discord_set,
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
            git_diff,
            git_log,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            update_download,
            update_install,
            build_flavor,
            set_tray_reset,
            hide_to_tray,
            debug_log,
            resize_cursor,
        ]);

    // global hotkeys, work system-wide.
    // If a combo is already taken (PowerToys Run, etc.), warn and continue
    // instead of panicking — tray click still works as fallback.
    // Second instance can't own the same global hotkey (first holds Alt+Space) — skip to avoid panic at build()
    let builder = if is_new_instance {
        builder
    } else {
        match tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
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
            let mic: tauri_plugin_global_shortcut::Shortcut =
                "ctrl+shift+m".parse().expect("valid hotkey");
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
        })
        .with_shortcuts(["alt+space", "ctrl+shift+m"])
    {
        Ok(shortcuts_builder) => builder.plugin(shortcuts_builder.build()),
        Err(e) => {
            eprintln!("global shortcut Alt+Space unavailable: {e}");
            builder
        }
        }
    };

    builder
        .setup(|app| {
            // system tray: left click toggles visibility, right click menu.
            // Both tray and pinned taskbar JumpList expose "Open new window"
            // and "Quit" so the two surfaces stay consistent.
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };

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
            let state = match spawn_server() {
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
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // track last focused HWND for system-wide hotkeys across multiple instances
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
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                }
                // staged update swap + relaunch — after the sidecar is dead
                // so its image file is no longer locked
                apply_on_exit();
                // terminal shell dies with the app
                if let Some(ses) = _app_handle
                    .state::<PtyState>()
                    .inner()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    ses.kill();
                }
                // discord ipc pipe close
                if let Some(state) = _app_handle.try_state::<DiscordState>() {
                    state.shutdown();
                }
            }
        });
}

