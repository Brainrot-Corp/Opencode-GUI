// OS glass material behind the translucent UI: Windows acrylic, macOS
// vibrancy, Linux/no-glass = no-op. `os_glass` tells the frontend whether
// the layer applied (false → paint opaque base).
use std::sync::atomic::{AtomicBool, Ordering};

// whether the OS glass layer (Mica) was applied — false means the frontend
// must paint an opaque base (no-glass build, or Mica unavailable)
static GLASS: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn os_glass() -> bool {
    GLASS.load(Ordering::Relaxed)
}

#[cfg(all(windows, not(feature = "noglass")))]
pub fn apply_glass(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    if window_vibrancy::apply_acrylic(&w, None).is_ok() {
        GLASS.store(true, Ordering::Relaxed);
    }
}

#[cfg(all(target_os = "macos", not(feature = "noglass")))]
pub fn apply_glass(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    // macOS vibrancy — Sidebar material preserves design glass with blur
    if window_vibrancy::apply_vibrancy(&w, window_vibrancy::NSVisualEffectMaterial::Sidebar, None, Some(12.0)).is_ok() {
        GLASS.store(true, Ordering::Relaxed);
    }
}

#[cfg(any(target_os = "linux", feature = "noglass", all(not(windows), not(target_os = "macos"))))]
pub fn apply_glass(_app: &tauri::AppHandle) {}
