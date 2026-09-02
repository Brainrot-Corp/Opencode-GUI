use std::path::PathBuf;
use tauri::Manager;

/// Cross-platform home directory. Mirrors `dirs::home_dir` without new dep:
/// try `HOME` (Unix), `USERPROFILE` (Windows), fallback to app_config parent if needed.
pub fn home_dir() -> PathBuf {
    if let Ok(h) = std::env::var("HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    // last resort: temp dir parent or current exe parent
    std::env::temp_dir()
}

/// Config root: always via Tauri's app_config_dir so macOS uses
/// `~/Library/Application Support/<bundle>` and Linux `~/.config`,
/// not a hardcoded `USERPROFILE/.config`.
pub fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| home_dir().join(".config").join("opencode-gui"))
}

pub fn themes_dir(app: &tauri::AppHandle) -> PathBuf {
    // legacy path was `home/.config/.opencode-gui` — now app_config_dir
    // which on mac is Library/Application Support, on Linux ~/.config/opencode-gui,
    // on Windows %APPDATA%/com.ewanr.opencode-gui
    // Keep migration attempt: if legacy exists and new doesn't, use legacy.
    let new_root = config_dir(app).join(".opencode-gui");
    if new_root.exists() {
        return new_root;
    }
    // check legacy USERPROFILE/.config/.opencode-gui
    let legacy = home_dir().join(".config").join(".opencode-gui");
    if legacy.exists() && !new_root.exists() {
        return legacy;
    }
    // default: prefer app_config_dir base; but keep .opencode-gui suffix for compatibility
    // Actually simpler: use dedicated subdir under app_config_dir without dot prefix
    // but to avoid breaking existing installs, keep new_root logic:
    // if neither exists, create under app_config_dir
    config_dir(app).join(".opencode-gui")
}

/// Simpler theme dir that just uses app_config directly (no dot nesting) — used for new installs
/// We keep `themes_dir()` above for compat; new code should call `themes_dir_new`.
pub fn plugins_dir(app: &tauri::AppHandle) -> PathBuf {
    themes_dir(app).join("plugins")
}

/// Open `path` with OS default handler.
pub fn open_path(path: &str) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn()
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()
    }
}

/// Reveal `path` in file manager (select file if not dir).
pub fn reveal_path(path: &str) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let p = std::path::Path::new(path);
        if p.is_dir() {
            std::process::Command::new("explorer")
                .arg(path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        } else {
            std::process::Command::new("explorer")
                .args(["/select,", path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        }
    }
    #[cfg(target_os = "macos")]
    {
        let p = std::path::Path::new(path);
        if p.is_dir() {
            std::process::Command::new("open").arg(path).spawn()
        } else {
            // -R reveals in Finder and selects
            std::process::Command::new("open").args(["-R", path]).spawn()
        }
    }
    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new(path);
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open").arg(dir).spawn()
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let p = std::path::Path::new(path);
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open").arg(dir).spawn()
    }
}

/// Reveal a directory (ensure exists).
pub fn reveal_dir(dir: &std::path::Path) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(dir).spawn()
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(dir).spawn()
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        std::process::Command::new("xdg-open").arg(dir).spawn()
    }
}

/// Default shell for PTY. Respects $SHELL on Unix.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

/// Resolve workdir for PTY/git/server: empty -> home_dir.
pub fn resolve_workdir(cwd: &str) -> PathBuf {
    let p = if cwd.is_empty() {
        home_dir()
    } else {
        PathBuf::from(cwd)
    };
    if p.is_dir() { p } else { home_dir() }
}

/// Sidecar candidates in priority order per OS.
pub fn sidecar_candidates() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        vec!["opencode.exe", "opencode-x86_64-pc-windows-msvc.exe"]
    }
    #[cfg(target_os = "macos")]
    {
        vec![
            "opencode",
            "opencode-aarch64-apple-darwin",
            "opencode-x86_64-apple-darwin",
            "opencode-x86_64-pc-windows-msvc.exe",
        ]
    }
    #[cfg(target_os = "linux")]
    {
        vec![
            "opencode",
            "opencode-x86_64-unknown-linux-gnu",
            "opencode-aarch64-unknown-linux-gnu",
            "opencode-x86_64-pc-windows-msvc.exe",
        ]
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        vec!["opencode", "opencode.exe"]
    }
}

/// curl binary name per OS.
pub fn curl_bin() -> &'static str {
    #[cfg(windows)]
    {
        "curl.exe"
    }
    #[cfg(not(windows))]
    {
        "curl"
    }
}

#[allow(dead_code)]
pub fn which_bin() -> &'static str {
    #[cfg(windows)]
    {
        "where"
    }
    #[cfg(not(windows))]
    {
        "which"
    }
}
