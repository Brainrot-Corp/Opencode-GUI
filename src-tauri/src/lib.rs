use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
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

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    use tauri::Emitter;
    let _ = app.emit("visibility://changed", true);
}

fn hide_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    use tauri::Emitter;
    let _ = app.emit("visibility://changed", false);
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
        // remembers window size/position across launches
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
                        let focused = w.is_focused().unwrap_or(false);
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

            let show = MenuItem::with_id(app, "show", "Show OpenCode", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenCode")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
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
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                hide_main(app);
                            } else {
                                show_main(app);
                            }
                        }
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
            // make sure the window actually owns keyboard focus on launch Ã¢â‚¬â€
            // otherwise the first Alt+Space sees "visible but unfocused" and
            // only focuses it instead of hiding it
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }

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

