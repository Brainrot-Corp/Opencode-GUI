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
        req = req.header("Content-Type", "application/json").body(b);
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
        pub fn LoadCursorW(hinstance: isize, name: *const u16) -> isize;
        pub fn SetCursor(hcursor: isize) -> isize;
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

// WebView2 intermittently drops its own WM_SETCURSOR handling, so CSS
// cursors (col-resize during the sidebar drag et al.) snap back to the
// class-cursor arrow. While the frontend holds an override, re-assert the
// native cursor on the UI thread every ~15ms — SetCursor is nearly free and
// wins no matter who ate the WM_SETCURSOR.
#[cfg(windows)]
static CUR_OVERRIDE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
#[cfg(windows)]
static CUR_PUMP: AtomicBool = AtomicBool::new(false);

// LoadCursorW resource ids from winuser.h
#[cfg(windows)]
fn native_cursor_id(shape: &str) -> i32 {
    match shape {
        "text" => 32513,      // IDC_IBEAM
        "crosshair" => 32515, // IDC_CROSS
        "col-resize" | "ew-resize" | "e-resize" | "w-resize" => 32644, // IDC_SIZEWE
        "row-resize" | "ns-resize" | "n-resize" | "s-resize" => 32645, // IDC_SIZENS
        "nwse-resize" => 32642,
        "nesw-resize" => 32643,
        "pointer" | "grab" | "grabbing" => 32649, // IDC_HAND
        _ => 32512,           // IDC_ARROW
    }
}

#[tauri::command]
fn set_cursor(app: tauri::AppHandle, shape: Option<String>) {
    #[cfg(windows)]
    {
        let id = shape.map(|s| native_cursor_id(&s)).unwrap_or(0);
        CUR_OVERRIDE.store(id, Ordering::Relaxed);
        // spawn-once eternal ticker; it reads CUR_OVERRIDE each tick, so a
        // cleared-then-re-set override can never race it into an early exit
        if id != 0 && !CUR_PUMP.swap(true, Ordering::SeqCst) {
            std::thread::spawn(move || loop {
                if CUR_OVERRIDE.load(Ordering::Relaxed) != 0 {
                    let _ = app.run_on_main_thread(|| unsafe {
                        use wininput::*;
                        SetCursor(LoadCursorW(
                            0,
                            CUR_OVERRIDE.load(Ordering::Relaxed) as *const u16,
                        ));
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            });
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, shape);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![
            server_url,
            os_glass,
            theme_config_read,
            theme_config_write,
            write_file,
            reveal_config_dir,
            plugins_scan,
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
            set_tray_reset,
            hide_to_tray,
            set_cursor,
            debug_log,
        ]);

    // global hotkeys, work system-wide.
    // If a combo is already taken (PowerToys Run, etc.), warn and continue
    // instead of panicking Ã¢â‚¬â€ tray click still works as fallback.
    let builder = match tauri_plugin_global_shortcut::Builder::new()
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
                    // mic toggle anywhere — frontend owns the real start/stop
                    use tauri::Emitter;
                    let _ = app.emit("mic://toggle", ());
                } else {
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
        })
        .with_shortcuts(["alt+space", "ctrl+shift+m"])
    {
        Ok(shortcuts_builder) => builder.plugin(shortcuts_builder.build()),
        Err(e) => {
            eprintln!("global shortcut Alt+Space unavailable: {e}");
            builder
        }
    };

    builder
        .setup(|app| {
            // system tray: left click toggles visibility, right click menu
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };

            let show = MenuItem::with_id(app, "show", "Show/Hide OpenCode GUI", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenCode")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_main(app),
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
                .build(app)?;

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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
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
            }
        });
}

