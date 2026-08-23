use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};

struct ServerState {
    port: u16,
    child: Mutex<Option<Child>>,
    error: Option<String>,
}

// ponytail: kill-on-exit handler covers normal close; a hard crash can orphan
// the server. Windows Job Objects (KILL_ON_JOB_CLOSE) if that ever matters.
fn spawn_server() -> std::io::Result<(Child, u16)> {
    let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
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
    #[cfg(not(debug_assertions))]
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null());
    Ok((cmd.spawn()?, port))
}

#[tauri::command]
fn server_url(state: State<'_, ServerState>) -> Result<String, String> {
    match state.error {
        Some(ref e) => Err(e.clone()),
        None => Ok(format!("http://127.0.0.1:{}", state.port)),
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            // global Alt+Space: toggle window visibility, works system-wide
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+space"])
                .expect("failed to register global shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            let focused = w.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = w.hide();
                            } else {
                                show_main(app);
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![server_url])
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
                                let _ = w.hide();
                            } else {
                                show_main(app);
                            }
                        }
                    }
                })
                .build(app)?;

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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
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
