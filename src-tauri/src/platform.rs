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
        win_command("cmd").args(["/C", "start", "", path]).spawn()
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

/// Reveal a directory (ensure exists).
pub fn reveal_dir(dir: &std::path::Path) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        win_command("explorer").arg(dir).spawn()
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

/// Spawn a child process without flashing a console window on Windows
/// (CREATE_NO_WINDOW). Other OS: plain Command — there is no console flash.
pub fn win_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program)
    }
}

/// Ephemeral loopback port for the sidecar server.
pub fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Quote-aware command-line tokenizer — single/double quotes group tokens,
/// no escape sequences (matches the previous per-caller copies in pty.rs /
/// terminals.rs). Callers needing %VAR% expansion do it before calling.
pub fn split_cmdline(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for ch in s.chars() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ' ' | '\t' if !in_single && !in_double => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Arg list for [`curl_download`] (binary excluded) — split out so the
/// `--max-filesize` gating has a unit test without spawning curl.
pub(crate) fn curl_download_args(url: &str, dest: &std::path::Path, cap: Option<u64>) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![
        "-L".into(),
        "--fail".into(),
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        "1800".into(),
    ];
    // curl parses --max-filesize as a signed 64-bit offset — anything above
    // i64::MAX fails with "too large number" (the auto-updater once passed
    // u64::MAX as "no cap"). Omit the flag instead of emitting garbage.
    if let Some(limit) = cap.filter(|&n| n <= i64::MAX as u64) {
        args.push("--max-filesize".into());
        args.push(limit.to_string().into());
    }
    args.push("-o".into());
    args.push(dest.into());
    args.push(url.into());
    args
}

/// Download `url` to `dest` via the OS curl binary (follows GitHub/HF
/// release redirects; `cap` enforces `--max-filesize` when `Some`).
/// Blocking — call from spawn_blocking. Removes a partial `dest` on failure.
pub fn curl_download(url: &str, dest: &std::path::Path, cap: Option<u64>) -> Result<(), String> {
    let mut cmd = win_command(curl_bin());
    cmd.args(curl_download_args(url, dest, cap));
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    let out = cmd.output().map_err(|e| format!("failed to run curl: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(dest);
        Err(format!(
            "download failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// macOS: vertically center the native traffic lights on the custom HTML
/// titlebar (42px — keep in sync with `src/components/Titlebar.tsx` TB_H).
/// macOS parks them at the stock titlebar height, which sits a few px above
/// the label's center. Re-call on window focus — fullscreen/zoom transitions
/// reset the frames. Non-fatal on failure.
#[cfg(target_os = "macos")]
pub fn center_traffic_lights(win: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};

    /// titlebar height / 2 — sync with Titlebar.tsx TB_H (42px)
    const CENTER_Y: f64 = 21.0;

    let ptr = match win.ns_window() {
        Ok(p) if !p.is_null() => p,
        _ => return,
    };
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    // fullscreen tears down the titlebar container (system hides the lights)
    // — touching the buttons mid-transition can crash
    if unsafe { ns.styleMask() }.contains(NSWindowStyleMask::FullScreen) {
        return;
    }

    unsafe {
        // buttons share one superview (NSTitlebarView); its frame height is
        // the coordinate space their origins live in (bottom-left origin)
        let Some(close) = ns.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let Some(container) = close.superview() else {
            return;
        };
        let ch = container.frame().size.height;
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(btn) = ns.standardWindowButton(kind) {
                let mut frame = btn.frame();
                // origin.y counts from container bottom; place the button so
                // its center lands at CENTER_Y from the window's top edge
                frame.origin.y = ch - CENTER_Y - frame.size.height / 2.0;
                btn.setFrameOrigin(frame.origin);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_flag(args: &[std::ffi::OsString], flag: &str) -> bool {
        args.iter().any(|a| a.to_string_lossy() == flag)
    }

    // regression: update_download passed u64::MAX as "no cap" and curl died
    // with `option --max-filesize: too large number`
    #[test]
    fn curl_args_omits_max_filesize_without_cap() {
        let dest = std::path::Path::new("update.zip");
        let args = curl_download_args("https://example.com/x.zip", dest, None);
        assert!(!has_flag(&args, "--max-filesize"));
        assert!(has_flag(&args, "--max-time"));
    }

    #[test]
    fn curl_args_keeps_sane_cap() {
        let dest = std::path::Path::new("part.bin");
        let args = curl_download_args("https://example.com/x", dest, Some(2 * 1024 * 1024 * 1024));
        let pos = args.iter().position(|a| a.to_string_lossy() == "--max-filesize").unwrap();
        assert_eq!(args[pos + 1].to_string_lossy(), "2147483648");
    }

    #[test]
    fn curl_args_never_emits_unparsable_cap() {
        let dest = std::path::Path::new("update.zip");
        for cap in [u64::MAX, i64::MAX as u64 + 1] {
            let args = curl_download_args("https://example.com/x.zip", dest, Some(cap));
            assert!(!has_flag(&args, "--max-filesize"), "cap {cap} must omit the flag");
        }
    }
}
