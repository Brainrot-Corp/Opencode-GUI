#[cfg(windows)]
mod imp {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;
    use winreg::enums::RegType::REG_BINARY;

    static AL_REGKEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    static TASK_MANAGER_OVERRIDE_REGKEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    static TASK_MANAGER_OVERRIDE_ENABLED_VALUE: [u8; 12] = [
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    fn app_name(app: &tauri::AppHandle) -> String {
        // Use same name as tauri-plugin-autostart (package_info.name = "opencode-gui")
        app.package_info().name.clone()
    }

    fn app_path_quoted() -> Result<String, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // Quote the path so "C:\Program Files\..." works — the upstream
        // auto-launch crate forgets quotes and breaks on spaced paths.
        Ok(format!("\"{}\"", exe.display()))
    }

    pub fn is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
        let name = app_name(&app);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let al_enabled = hkcu
            .open_subkey_with_flags(AL_REGKEY, KEY_READ)
            .map_err(|e| e.to_string())?
            .get_value::<String, _>(&name)
            .is_ok();
        // Task Manager can override via StartupApproved — if that key says disabled,
        // treat as disabled even though Run entry exists.
        let task_manager_enabled = hkcu
            .open_subkey_with_flags(TASK_MANAGER_OVERRIDE_REGKEY, KEY_READ)
            .ok()
            .and_then(|k| k.get_raw_value(&name).ok())
            .and_then(|v| {
                if v.bytes.len() < 8 {
                    return None;
                }
                Some(v.bytes.iter().rev().take(8).all(|b| *b == 0))
            });
        // If override says disabled (false), overall disabled; otherwise follow Run key.
        if let Some(false) = task_manager_enabled {
            return Ok(false);
        }
        Ok(al_enabled)
    }

    pub fn enable(app: tauri::AppHandle) -> Result<(), String> {
        let name = app_name(&app);
        let quoted = app_path_quoted()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey_with_flags(AL_REGKEY, KEY_SET_VALUE)
            .map_err(|e| e.to_string())?
            .set_value(&name, &quoted)
            .map_err(|e| e.to_string())?;
        // Re-enable in Task Manager's StartupApproved so it actually launches
        if let Ok(reg) = hkcu.open_subkey_with_flags(TASK_MANAGER_OVERRIDE_REGKEY, KEY_SET_VALUE) {
            let _ = reg.set_raw_value(
                &name,
                &winreg::RegValue {
                    vtype: REG_BINARY,
                    bytes: TASK_MANAGER_OVERRIDE_ENABLED_VALUE.to_vec(),
                },
            );
        }
        Ok(())
    }

    pub fn disable(app: tauri::AppHandle) -> Result<(), String> {
        let name = app_name(&app);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey_with_flags(AL_REGKEY, KEY_SET_VALUE)
            .map_err(|e| e.to_string())?
            .delete_value(&name)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::Manager;
    // On macOS/Linux delegate to the auto_launch crate via the plugin's manager,
    // but we reimplement minimally via the plugin's state to avoid duplicating logic.
    // Fallback: use the plugin's manager if available, otherwise try auto_launch directly.
    pub fn is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
        // Try plugin state first
        if let Some(mgr) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
            return mgr.is_enabled().map_err(|e| e.to_string());
        }
        Err("autostart not available on this platform".into())
    }
    pub fn enable(app: tauri::AppHandle) -> Result<(), String> {
        if let Some(mgr) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
            return mgr.enable().map_err(|e| e.to_string());
        }
        Err("autostart not available".into())
    }
    pub fn disable(app: tauri::AppHandle) -> Result<(), String> {
        if let Some(mgr) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
            return mgr.disable().map_err(|e| e.to_string());
        }
        Err("autostart not available".into())
    }
}

#[tauri::command]
pub fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    imp::is_enabled(app)
}

#[tauri::command]
pub fn autostart_enable(app: tauri::AppHandle) -> Result<(), String> {
    imp::enable(app)
}

#[tauri::command]
pub fn autostart_disable(app: tauri::AppHandle) -> Result<(), String> {
    imp::disable(app)
}
