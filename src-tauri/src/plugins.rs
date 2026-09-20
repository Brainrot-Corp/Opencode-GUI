// Rust side of the theme/plugin system: scan plugin folders, read/write the
// theme config, generic plugin http fetch, reveal + remove/install commands,
// and the config-dir watcher that drives hot reload.
use std::path::PathBuf;

// legacy theme/plugin dirs (pre app_config_dir installs)
pub(crate) fn legacy_themes_dir() -> PathBuf {
    let home = crate::platform::home_dir();
    home.join(".config").join(".opencode-gui")
}
pub(crate) fn legacy_plugins_dir() -> PathBuf {
    legacy_themes_dir().join("plugins")
}

// one folder per plugin under plugins/: plugin.json + main.js (+ styles.css).
// Raw file contents only — validation and manifest parsing live frontend-side
#[derive(serde::Serialize)]
pub struct PluginDir {
    pub dir: String,
    pub manifest: String,
    pub main: String,
    pub css: String,
}

#[tauri::command]
pub fn plugins_scan(app: tauri::AppHandle) -> Vec<PluginDir> {
    // prefer app-aware dir, fallback to legacy for existing installs
    let dir = crate::platform::plugins_dir(&app);
    let fallback = legacy_plugins_dir();
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).or_else(|_| std::fs::read_dir(&fallback));
    let Ok(entries) = entries else {
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
// request/response envelope, no cookies, 10s timeout.
// Public http is blocked; private LAN http (Hue bridge etc.) is allowed.
#[tauri::command]
pub async fn http_json(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let is_https = url.starts_with("https://");
    let is_private_http = url.starts_with("http://192.168.")
        || url.starts_with("http://10.")
        || url.starts_with("http://172.16.")
        || url.starts_with("http://172.17.")
        || url.starts_with("http://172.18.")
        || url.starts_with("http://172.19.")
        || url.starts_with("http://172.20.")
        || url.starts_with("http://172.21.")
        || url.starts_with("http://172.22.")
        || url.starts_with("http://172.23.")
        || url.starts_with("http://172.24.")
        || url.starts_with("http://172.25.")
        || url.starts_with("http://172.26.")
        || url.starts_with("http://172.27.")
        || url.starts_with("http://172.28.")
        || url.starts_with("http://172.29.")
        || url.starts_with("http://172.30.")
        || url.starts_with("http://172.31.")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost");
    if !(is_https || is_private_http) {
        return Err("only https:// and private http:// (Hue LAN) urls are allowed".into());
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
        let has_ct = headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"));
        // Don't default to application/json for empty bodies (411 Length Required on Spotify PUT/POST with no body)
        if !has_ct && !b.is_empty() {
            req = req.header("Content-Type", "application/json");
        }
        req = req.body(b);
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
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": text, "link": link, "retryAfter": retry_after }))
}

#[tauri::command]
pub fn theme_config_read(app: tauri::AppHandle) -> Result<String, String> {
    // try app-aware dir first, fallback to legacy
    let p = crate::platform::themes_dir(&app).join("themes.json");
    let p2 = legacy_themes_dir().join("themes.json");
    let path = if p.exists() { p } else if p2.exists() { p2 } else { p };
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn theme_config_write(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let dir = crate::platform::themes_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("themes.json"), content).map_err(|e| e.to_string())?;
    // also migrate legacy if existed
    Ok(())
}

#[tauri::command]
pub fn reveal_config_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::platform::themes_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::platform::reveal_dir(&dir).map(|_| ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reveal_plugins_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::platform::plugins_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::platform::reveal_dir(&dir).map(|_| ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn plugin_remove(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let name = dir.trim().to_string();
    if name.is_empty() {
        return Err("empty plugin name".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(':') {
        return Err("invalid plugin name".into());
    }
    let base = crate::platform::plugins_dir(&app);
    let target = base.join(&name);
    // fallback to legacy if not found in new
    let target = if target.exists() { target } else { legacy_plugins_dir().join(&name) };
    if !target.exists() {
        return Err("plugin not found".into());
    }
    let canon_plugins = base.canonicalize().unwrap_or_else(|_| base.clone());
    let canon_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_plugins) {
        // also allow legacy base
        let legacy_base = legacy_plugins_dir().canonicalize().unwrap_or_else(|_| legacy_plugins_dir());
        if !canon_target.starts_with(&legacy_base) {
            return Err("invalid plugin path".into());
        }
    }
    std::fs::remove_dir_all(&canon_target).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn plugin_install_files(app: tauri::AppHandle, dir: String, manifest: String, main: String, css: String) -> Result<(), String> {
    let name = dir.trim().to_string();
    if name.is_empty() {
        return Err("empty plugin name".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(':') {
        return Err("invalid plugin name".into());
    }
    if manifest.trim().is_empty() {
        return Err("missing plugin.json".into());
    }
    if main.trim().is_empty() {
        return Err("missing main.js".into());
    }
    serde_json::from_str::<serde_json::Value>(&manifest).map_err(|e| format!("bad plugin.json: {e}"))?;
    let base = crate::platform::plugins_dir(&app);
    let target = base.join(&name);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let canon_plugins = base.canonicalize().unwrap_or_else(|_| base.clone());
    let canon_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_plugins) {
        return Err("invalid plugin path".into());
    }
    std::fs::write(canon_target.join("plugin.json"), manifest).map_err(|e| e.to_string())?;
    std::fs::write(canon_target.join("main.js"), main).map_err(|e| e.to_string())?;
    if css.trim().is_empty() {
        let _ = std::fs::remove_file(canon_target.join("styles.css"));
    } else {
        std::fs::write(canon_target.join("styles.css"), css).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// watch a config dir; coalesce bursts of events into one emit
pub(crate) fn watch_dir(handle: tauri::AppHandle, path: PathBuf, event: &'static str, recursive: bool) {
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

/// Watch both new + legacy theme/plugin dirs (legacy only when different).
pub(crate) fn watch_all(handle: tauri::AppHandle) {
    let h = handle;
    let new_themes = crate::platform::themes_dir(&h);
    let new_plugins = crate::platform::plugins_dir(&h);
    watch_dir(h.clone(), new_themes.clone(), "themes://changed", false);
    watch_dir(h.clone(), new_plugins.clone(), "plugins://changed", true);
    // fallback legacy watch for existing installs that may still use old path
    let legacy_themes = legacy_themes_dir();
    let legacy_plugins = legacy_plugins_dir();
    if legacy_themes != new_themes {
        watch_dir(h.clone(), legacy_themes, "themes://changed", false);
        watch_dir(h, legacy_plugins, "plugins://changed", true);
    }
}
