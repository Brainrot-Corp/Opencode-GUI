// main-window show/hide/toggle + tray reopen sizing + secondary-instance
// spawning + JumpList. Shared by the tray, global hotkeys, IPC forwarding
// and the close-to-tray paths.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

#[cfg(windows)]
pub(crate) use crate::input::unpoison_input;
#[cfg(not(windows))]
pub(crate) fn unpoison_input(_app: &tauri::AppHandle) {}

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

/// True when the "Keep window size" marker file exists (setting ON).
pub(crate) fn keep_size_flag_present(app: &tauri::AppHandle) -> bool {
    keep_size_flag(app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn set_tray_reset(app: tauri::AppHandle, enabled: bool) {
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

pub(crate) fn tray_reset_enabled() -> bool {
    TRAY_RESET.load(Ordering::Relaxed)
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

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.set_focus();
        unpoison_input(app);
    }
    use tauri::Emitter;
    let _ = app.emit("visibility://changed", true);
}

pub(crate) fn hide_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // hide FIRST, then resize while invisible: a programmatic set_size
        // on a visible window is what poisons WebView2's input pipeline.
        // The reopen still lands at the default size — same end state as
        // the old pre-hide resize, minus the poisoning
        let _ = w.hide();
        if tray_reset_enabled() {
            apply_default_size(app);
        }
    }
    use tauri::Emitter;
    let _ = app.emit("visibility://changed", false);
}

/// hide path for the native CloseRequested guard — same as hide_main, kept
/// as a named entry point so lib.rs's RunEvent handler stays readable.
pub(crate) fn hide_main_for_close(app: &tauri::AppHandle) {
    hide_main(app);
}

// visibility-only toggle shared by the tray icon click and the tray menu —
// unlike Alt+Space there is no focus check: both are explicit user intents
pub(crate) fn toggle_main(app: &tauri::AppHandle) {
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
pub fn hide_to_tray(app: tauri::AppHandle) {
    hide_main(&app);
}

// mirrors the frontend "Close on X" setting so NATIVE close paths (mac red
// stoplight, taskbar "Close window") can honor it. false = hide to tray,
// matching the setting's default before the webview syncs.
static CLOSE_ON_X: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub fn set_close_on_x(on: bool) {
    CLOSE_ON_X.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn close_on_x() -> bool {
    CLOSE_ON_X.load(std::sync::atomic::Ordering::Relaxed)
}

// real quit that bypasses the CloseRequested guard — used by the custom X
// button when it means "quit" (setting on, or Ctrl-held invert)
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn toggle_window(app: tauri::AppHandle) {
    toggle_main(&app);
}

// ground-truth focus check for the Alt+Space toggle: after an interactive
// resize, tao's internal focus tracking desyncs and is_focused() reports
// false until a hide/minimize cycle resets it — making the hotkey take the
// "show" branch on an already-visible window. Ask user32 directly instead.
// Windows-only: called exclusively from the input module's hotkey router.
#[cfg(windows)]
pub(crate) fn window_focused(win: &tauri::WebviewWindow) -> bool {
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

// TEMP diagnostics — appends frontend errors to %TEMP%\oc-gui-debug.log so
// they survive a hard renderer crash (remove once the crash is fixed)
#[tauri::command]
pub fn debug_log(msg: String) {
    use std::io::Write;
    let path = std::env::temp_dir().join("oc-gui-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

// debug-only sink so setup paths can leave breadcrumbs in release builds
// without shipping the disk writes
#[cfg(debug_assertions)]
pub(crate) fn log_dbg(msg: String) {
    debug_log(msg);
}
#[cfg(not(debug_assertions))]
pub(crate) fn log_dbg(_msg: String) {}

// snap the main window back to the size declared in tauri.conf.json — shared
// by the tray-reopen reset and the launch reset ("Keep window size" off)
pub(crate) fn apply_default_size(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // never shrink a window carrying the maximized flag without clearing
        // it first — parent/webview geometry desyncs and hovers go dead
        // until the next click
        if w.is_maximized().unwrap_or(false) {
            #[cfg(desktop)]
            {
                let _ = w.unmaximize();
            }
        }
        let (width, height) = default_size(app);
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
    }
}

#[tauri::command]
pub fn spawn_new_instance() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("spawn_new_instance: current_exe failed: {e}");
            log_dbg(format!("spawn_new_instance current_exe failed: {e}"));
            return;
        }
    };
    let mut cmd = crate::platform::win_command(&exe);
    cmd.arg("--new-instance");
    match cmd.spawn() {
        Ok(_) => {
            log_dbg(format!("spawn_new_instance ok: {}", exe.display()));
        }
        Err(e) => {
            eprintln!("spawn_new_instance spawn failed: {e}");
            log_dbg(format!("spawn_new_instance spawn failed: {e}"));
        }
    }
}

#[cfg(windows)]
pub(crate) fn apply_jumplist(_app: &tauri::AppHandle) {
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
pub(crate) fn apply_jumplist(_app: &tauri::AppHandle) {}
