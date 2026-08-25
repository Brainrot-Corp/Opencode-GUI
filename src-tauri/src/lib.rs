use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State, WindowEvent};

mod browser;
use browser::{browser_back, browser_close, browser_forward, browser_navigate, browser_open,
    browser_reload, open_app, open_external, window_app};

mod voice;
use voice::{install_bin_finalize, install_model_finalize, install_piper_bin, install_tts_voice_part, tts_remove_voice, tts_speak, tts_status, voice_download, voice_remove_model,
    voice_status, voice_transcribe};

mod git;
use git::{git_commit, git_diff, git_discard, git_log, git_pull, git_push, git_stage, git_status, git_unstage};

mod tuya;
use tuya::{tuya_lights, tuya_send};

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

// block until the spawned server actually accepts TCP connections —
// `serve` takes a moment to bind its port, and the frontend fires
// session/provider fetches the instant it gets the URL
fn wait_ready(port: u16, timeout: std::time::Duration) -> bool {
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250))
            .is_ok()
        {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

#[tauri::command]
fn server_url(state: State<'_, ServerState>) -> Result<String, String> {
    match state.error {
        Some(ref e) => Err(e.clone()),
        None => Ok(format!("http://127.0.0.1:{}", state.port)),
    }
}

// theme config: ~/.config/.opencode-gui/themes.json Ã¢â‚¬â€ read by the frontend,
// seeded once by it, and watched here so edits hot-reload the UI
fn themes_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home).join(".config").join(".opencode-gui")
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

// watch the theme config dir; coalesce bursts of events into one emit
fn watch_themes(handle: tauri::AppHandle) {
    use notify::Watcher as _;
    let _ = std::fs::create_dir_all(themes_dir());
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("theme watcher unavailable: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&themes_dir(), notify::RecursiveMode::NonRecursive) {
        eprintln!("theme watch failed: {e}");
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
            let _ = handle.emit("themes://changed", ());
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
            theme_config_read,
            theme_config_write,
            reveal_config_dir,
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
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_diff,
            git_log,
            tuya_lights,
            tuya_send
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

            let state = match spawn_server() {
                Ok((child, port)) => {
                    if wait_ready(port, std::time::Duration::from_secs(30)) {
                        ServerState {
                            port,
                            child: Mutex::new(Some(child)),
                            error: None,
                        }
                    } else {
                        ServerState {
                            port: 0,
                            child: Mutex::new(Some(child)),
                            error: Some("opencode serve did not become ready in 30s".into()),
                        }
                    }
                }
                Err(e) => ServerState {
                    port: 0,
                    child: Mutex::new(None),
                    error: Some(format!("failed to start opencode serve: {e}")),
                },
            };
            app.manage(state);
            app.manage(browser::BrowserState::default());
            app.manage(tuya::TuyaState(Mutex::new(None)));
            watch_themes(app.handle().clone());
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

