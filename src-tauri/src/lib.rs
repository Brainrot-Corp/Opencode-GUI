#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::{Manager, RunEvent, WindowEvent};

mod glass;
#[cfg(desktop)]
use glass::apply_glass;
use glass::os_glass;

#[cfg_attr(not(desktop), allow(dead_code))]
mod platform;

#[cfg(desktop)]
mod autostart;
#[cfg(desktop)]
use autostart::{autostart_disable, autostart_enable, autostart_is_enabled};

#[cfg(desktop)]
mod browser;
#[cfg(desktop)]
use browser::{browser_back, browser_close, browser_forward, browser_navigate, browser_open,
    browser_reload, open_app, open_external, tiktok_close, tiktok_navigate, tiktok_open,
    tiktok_set_bounds, tiktok_set_glass, window_app};

#[cfg(desktop)]
mod discord;
#[cfg(desktop)]
use discord::{
    discord_clear, discord_close, discord_get_start_ts, discord_set, discord_status, DiscordState,
};

mod discover;
use discover::relay_discover;

#[cfg(desktop)]
mod files;
#[cfg(desktop)]
use files::{file_create, file_delete, file_duplicate, file_import, file_open, file_rename, window_scope,
    user_home, workspace_get, workspace_is_dir, workspace_set, write_file};

#[cfg(desktop)]
mod git;
#[cfg(desktop)]
use git::{git_commit, git_diff, git_diff_stat, git_discard, git_fetch, git_log, git_merge_abort, git_merge_continue, git_publish, git_pull, git_push, git_rebase_abort, git_rebase_continue, git_resolve, git_stage, git_stash_pop, git_stash_push, git_status, git_sync, git_unstage, git_watch};

#[cfg(windows)]
mod input;
#[cfg(windows)]
use input::{handle_global_shortcut, ipc_hook, read_last_focused, send_ipc_to_hwnd, webfocus,
    write_last_focused, IPC_SHOW};

#[cfg(desktop)]
mod plugins;
#[cfg(desktop)]
use plugins::{http_json, plugin_install_files, plugin_remove, plugins_scan, reveal_config_dir,
    reveal_plugins_dir, theme_config_read, theme_config_write};

#[cfg(desktop)]
mod pty;
#[cfg(desktop)]
use pty::{kill_all as pty_kill_all, pty_kill, pty_resize, pty_spawn, pty_write, PtyState};

#[cfg(desktop)]
mod remote;
#[cfg(desktop)]
use remote::{
    remote_base_url, remote_ensure, remote_get_key, remote_remove, remote_set_key,
    remote_status, remote_terminals, remote_test, RemoteState,
};

#[cfg(desktop)]
mod relay;
#[cfg(desktop)]
use relay::{relay_start, relay_status, relay_stop};

#[cfg(desktop)]
mod server;
#[cfg(desktop)]
use server::{server_url, spawn_server, ServerState};

#[cfg(desktop)]
mod terminals;
#[cfg(desktop)]
use terminals::list_terminals;

#[cfg(desktop)]
mod update;
#[cfg(desktop)]
use update::{apply_on_exit, build_flavor, update_download, update_install, update_stage_local};

#[cfg(desktop)]
mod voice;
#[cfg(desktop)]
use voice::{install_bin_finalize, install_model_finalize, install_piper_bin, install_tts_voice_part,
kokoro_remove_engine, install_kokoro_gpu_part, tts_gpu_remove, tts_remove_voice, tts_speak, tts_speak_pcm, tts_warm, tts_status, tts_debug_log, tts_clear_debug, voice_download, voice_gpu, voice_remove_all, voice_remove_gpu, voice_remove_model,
    voice_status, voice_transcribe, voice_transcribe_pcm};

#[cfg(desktop)]
mod windowctl;
#[cfg(desktop)]
use windowctl::{apply_default_size, debug_log, hide_to_tray, quit_app, set_close_on_x,
    set_tray_reset, show_main, spawn_new_instance, toggle_window};
#[cfg(desktop)]
use windowctl::{apply_jumplist, toggle_main};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // --new-instance bypasses the single-instance mutex so an explicit
    // "Open new window" can spawn a second independent process. All other
    // second launches go through the single-instance callback and restore
    // the existing window (left-click on pinned taskbar).
    let is_new_instance = std::env::args().any(|a| a == "--new-instance");
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // remembers window size/position across launches — but never
        // visibility: the window is created hidden ("visible": false) and
        // shown explicitly in setup once the launch resize has run on it
        builder = builder
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
            ));
    }
    builder = builder
        // native folder picker for the workspace setting
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(desktop)]
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
    #[cfg(not(desktop))]
    let _ = is_new_instance;
    // mobile (android/ios) is a notification + relay client: it invokes no
    // Rust commands yet — the notification plugin's JS API is the surface.
    // Desktop registers the full command set.
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![os_glass, relay_discover]);
    #[cfg(desktop)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            server_url,
            os_glass,
            relay_discover,
            window_scope,
            user_home,
            workspace_get,
            workspace_set,
            set_close_on_x,
            quit_app,
            theme_config_read,
            theme_config_write,
            write_file,
            file_create,
            file_delete,
            file_rename,
            file_duplicate,
            file_import,
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
            voice_gpu,
            voice_transcribe,
            voice_transcribe_pcm,
            voice_download,
            install_bin_finalize,
            install_model_finalize,
            voice_remove_model,
            voice_remove_gpu,
            tts_status,
            tts_speak,
            tts_speak_pcm,
            tts_warm,
            install_piper_bin,
            install_tts_voice_part,
            tts_remove_voice,
            install_kokoro_gpu_part,
            tts_gpu_remove,
            tts_debug_log,
            tts_clear_debug,
            kokoro_remove_engine,
            voice_remove_all,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_sync,
            git_diff,
            git_diff_stat,
            git_log,
            git_publish,
            git_stash_push,
            git_stash_pop,
            git_resolve,
            git_merge_abort,
            git_merge_continue,
            git_rebase_abort,
            git_rebase_continue,
            git_watch,
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
            remote_test,
            remote_ensure,
            remote_base_url,
            remote_status,
            remote_remove,
            remote_set_key,
            remote_get_key,
            remote_get_key,
            remote_terminals,
            relay_start,
            relay_status,
            relay_stop,
        ]);

    // global hotkeys, work system-wide. The plugin itself registers nothing;
    // combos are registered per-shortcut in setup() via on_shortcut so a
    // taken combo (second instance, PowerToys Run) only skips that combo —
    // with_shortcuts would abort plugin setup and the app, which is why
    // --new-instance used to skip the plugin entirely, silently leaving the
    // app with NO hotkeys after every auto-update relaunch (update.rs spawns
    // --new-instance while the old owner is already gone).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    // OS notifications — the mobile app's system banners (phase 2); desktop
    // gets the plugin too (harmless) so the crate compiles for every target
    let builder = builder.plugin(tauri_plugin_notification::init());

    builder
        .setup(|app| {
            #[cfg(not(desktop))]
            let _ = app;
            // system tray: left click toggles visibility, right click menu.
            // Both tray and pinned taskbar JumpList expose "Open new window"
            // and "Quit" so the two surfaces stay consistent.
            #[cfg(windows)]
            {
                // register global hotkeys one by one: a taken combo (second
                // instance, PowerToys Run) only skips that combo instead of
                // aborting plugin setup
                use tauri_plugin_global_shortcut::GlobalShortcutExt;

                for combo in ["alt+space", "ctrl+shift+m"] {
                    if let Err(e) = app
                        .global_shortcut()
                        .on_shortcut(combo, handle_global_shortcut)
                    {
                        eprintln!("global shortcut {combo} unavailable: {e}");
                    }
                }
            }
            #[cfg(desktop)]
            {
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
            }

            // Pinned taskbar JumpList — mirrors tray: "Open new window" + "Quit"
            // Everything below is the desktop backend: sidecar, file tree,
            // plugins, glass, tray-sizing — none of it exists on mobile.
            #[cfg(desktop)]
            {
                apply_jumplist(app.handle());

                // don't wait for the sidecar to bind — hand out the URL
                // immediately; the frontend renders on templates and polls
                // silently until the server answers
                // debug local builds restore last workspace as server CWD so
                // file tree works even before the frontend's ?directory= hydrates
                let saved_ws = files::read_saved_workspace(app.handle());
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
                app.manage(RemoteState::default());
                crate::remote::init(app.handle().clone());
                app.manage(browser::BrowserState::default());
                app.manage(browser::FloatingState::default());
                app.manage(PtyState::default());
                app.manage(relay::RelayState {
                    child: Mutex::new(None),
                });
                app.manage(DiscordState::default());
                update::cleanup_old();
                plugins::watch_all(app.handle().clone());
                apply_glass(app.handle());
                // the window is created hidden (tauri.conf.json "visible": false)
                // so any launch-time resize happens on an invisible window — a
                // programmatic set_size on a visible one poisons WebView2 input.
                // "Keep window size" OFF (the default): undo the window-state
                // plugin's restore first. The marker file mirrors the setting
                // because the webview hasn't loaded yet — its set_tray_reset
                // sync only lands later
                if !windowctl::keep_size_flag_present(app.handle()) {
                    apply_default_size(app.handle());
                }
                // show + focus + input repair. The explicit focus matters: the
                // first Alt+Space must see "visible and focused" to hide again
                show_main(app.handle());

                // mac: align the native traffic lights with the HTML titlebar's
                // vertical center (macOS parks them at the stock titlebar height)
                #[cfg(target_os = "macos")]
                if let Some(w) = app.handle().get_webview_window("main") {
                    crate::platform::center_traffic_lights(&w);
                }

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
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("tauri build failed: {e}");
            std::process::exit(1);
        })
        .run(|_app_handle, event| {
            #[cfg(not(desktop))]
            let _ = event;
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
            // mac: fullscreen/zoom transitions reset the traffic-light
            // frames — re-center on every focus (idempotent, cheap)
            #[cfg(target_os = "macos")]
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Focused(true),
                ..
            } = &event
            {
                if label == "main" {
                    if let Some(w) = _app_handle.get_webview_window("main") {
                        crate::platform::center_traffic_lights(&w);
                    }
                }
            }
            // keep the browser webview glued below the top bar across
            // window resizes / DPI changes while it is open
            #[cfg(desktop)]
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
            // mac: fullscreen/zoom transitions reset the traffic-light frames
            // asynchronously — AFTER the final resize of the animation, and
            // fullscreen never changes focus. Debounce a re-center on resizes
            // so it lands once the layout has settled (idempotent, cheap)
            #[cfg(target_os = "macos")]
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Resized(_),
                ..
            } = &event
            {
                if label == "main" {
                    use std::sync::atomic::{AtomicUsize, Ordering};
                    static TL_GEN: AtomicUsize = AtomicUsize::new(0);
                    let gen = TL_GEN.fetch_add(1, Ordering::Relaxed) + 1;
                    let h = _app_handle.clone();
                    std::thread::spawn(move || {
                        // two passes: right after the animation settles, then
                        // again in case AppKit re-laid the buttons later
                        for delay_ms in [250, 600] {
                            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                            if TL_GEN.load(Ordering::Relaxed) != gen {
                                return; // a newer resize superseded this pass
                            }
                            // AppKit calls MUST run on the main thread — the
                            // off-main path crashed during fullscreen resizes
                            let hc = h.clone();
                            let ht = hc.clone();
                            let _ = hc.run_on_main_thread(move || {
                                if let Some(w) = ht.get_webview_window("main") {
                                    crate::platform::center_traffic_lights(&w);
                                }
                            });
                        }
                    });
                }
            }
            // mac: Dock icon click while trayed — macOS fires Reopen
            // (applicationShouldHandleReopen). An explicit reopen is always
            // show intent, mirroring the tray click's else branch
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = &event {
                show_main(_app_handle);
            }
            // native close paths (mac red stoplight, taskbar "Close window"):
            // default to hide-to-tray like every other path out of the app,
            // unless the user opted into real quits ("Close on X" setting)
            #[cfg(desktop)]
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = &event
            {
                if label == "main" && !windowctl::close_on_x() {
                    api.prevent_close();
                    windowctl::hide_main_for_close(_app_handle);
                }
            }
            // desktop shutdown: sidecar, ptys, ssh tunnels, staged update
            // swap, discord ipc — none of it exists on mobile
            #[cfg(desktop)]
            if let RunEvent::Exit = event {
                // shutdown persistent whisper server (GPU) if running
                voice::shutdown_whisper_server();
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
                // terminal shells die with the app — before the update swap,
                // a pty running the opencode CLI would hold the old sidecar
                // image locked and silently break the file swap below
                if let Some(state) = _app_handle.try_state::<PtyState>() {
                    pty_kill_all(&state);
                }
                // ssh tunnels + remote serves die with the app
                if let Some(state) = _app_handle.try_state::<RemoteState>() {
                    crate::remote::kill_all(&state);
                }
                // staged update swap + relaunch — after the sidecar is dead
                // so its image file is no longer locked
                apply_on_exit();
                // discord ipc pipe close
                if let Some(state) = _app_handle.try_state::<DiscordState>() {
                    state.shutdown();
                }
            }
        });
}

// non-Windows desktop builds: no input module, and resize_cursor is a stub
// (the frontend guards on platform anyway). Mobile needs neither.
#[cfg(all(desktop, not(windows)))]
#[tauri::command]
fn resize_cursor() -> Option<serde_json::Value> {
    None
}
#[cfg(windows)]
use input::resize_cursor;
