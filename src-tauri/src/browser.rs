use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalSize, State, Url, Webview,
    WebviewUrl, WebviewBuilder, WebviewWindow, Wry,
};

pub struct Browser {
    webview: Webview<Wry>,
    top: f64,
    hist: Vec<String>,
    idx: usize,
    gen: u64,
}

#[derive(Default)]
pub struct BrowserState(pub Mutex<Option<Browser>>);

static GEN: AtomicU64 = AtomicU64::new(0);

// TEMP-DIAG: append a line to a trace file so the JS/Rust handoff can be
// verified without a debugger attached
fn diag(msg: &str) {
    let path = std::env::temp_dir().join("opencode").join("browser-diag.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "[{:?}] {}", std::time::SystemTime::now(), msg);
    }
}

// LOCK DISCIPLINE: every command here is async (sync commands run on the
// MAIN thread, and add_child/navigate/close block waiting on it — holding
// either while the other waits deadlocked the whole app). The mutex only
// ever guards plain data: clone the Webview handle / read fields under a
// short lock, drop it, THEN call into the webview.
//
// One history rule for every observed URL: same as current entry → no-op,
// matches another entry (incl. native mouse4/5 back-forward inside the
// child) → jump there, else truncate forward and push. Keeps our stack in
// sync with WebView2's own history without navigation callbacks.
fn classify(b: &mut Browser, url: &str) -> (bool, bool) {
    if b.hist.get(b.idx).map(String::as_str) == Some(url) {
        return (b.idx > 0, b.idx + 1 < b.hist.len());
    }
    match b.hist.iter().position(|u| u == url) {
        Some(k) => {
            b.idx = k;
            (b.idx > 0, b.idx + 1 < b.hist.len())
        }
        None => {
            b.hist.truncate(b.idx + 1);
            b.hist.push(url.to_string());
            b.idx = b.hist.len() - 1;
            (b.idx > 0, false)
        }
    }
}

fn spawn_poll(app: AppHandle, gen: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(400));
        let wv = {
            let state = app.state::<BrowserState>();
            let Ok(mut guard) = state.0.lock() else { return };
            let Some(b) = guard.as_mut() else { return };
            if b.gen != gen {
                return;
            }
            b.webview.clone()
        };
        let Ok(url) = wv.url() else { continue };
        let s = url.to_string();
        let payload = {
            let state = app.state::<BrowserState>();
            let Ok(mut guard) = state.0.lock() else { continue };
            let Some(b) = guard.as_mut() else { continue };
            if b.gen != gen {
                return;
            }
            let (can_back, can_fwd) = classify(b, &s);
            serde_json::json!({ "url": s, "canBack": can_back, "canFwd": can_fwd })
        };
        let _ = app.emit("browser://nav", payload);
    });
}

fn parse_http(url: &str) -> Result<Url, String> {
    let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("only http(s) urls are supported".into()),
    }
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    window: WebviewWindow<Wry>,
    state: State<'_, BrowserState>,
    url: String,
    top: f64,
) -> Result<(), String> {
    let parsed = parse_http(&url)?;
    diag(&format!("open entry url={url} top={top}"));

    // already browsing — follow the link in place
    let existing = state.0.lock().unwrap().as_ref().map(|b| b.webview.clone());
    if let Some(wv) = existing {
        diag("open: already browsing, navigating");
        let s = parsed.to_string();
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        if let Some(b) = state.0.lock().unwrap().as_mut() {
            b.hist.truncate(b.idx + 1);
            b.hist.push(s);
            b.idx = b.hist.len() - 1;
        }
        return Ok(());
    }

    // create — must NOT hold the lock across add_child
    let win = window.as_ref().window();
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let size = win
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    if size.height <= top + 40.0 {
        return Err("window too small".into());
    }

    let gen = GEN.fetch_add(1, Ordering::Relaxed);
    let webview = match win.add_child(
        WebviewBuilder::new("browser", WebviewUrl::External(parsed.clone())).incognito(true),
        LogicalPosition::new(0.0, top),
        LogicalSize::new(size.width, size.height - top),
    ) {
        Ok(w) => {
            diag("open: webview created");
            w
        }
        Err(e) => {
            diag(&format!("open: add_child FAILED: {e}"));
            return Err(e.to_string());
        }
    };

    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        // lost a race with another opener — keep theirs, drop ours
        drop(guard);
        let _ = webview.close();
        diag("open: lost race, dropped duplicate");
        return Ok(());
    }
    *guard = Some(Browser {
        webview,
        top,
        hist: vec![parsed.to_string()],
        idx: 0,
        gen,
    });
    drop(guard);
    diag("open: stored state, spawning poll");
    spawn_poll(app.clone(), gen);
    // nudge the main webview in case WebView2 paused its composition once
    // the opaque child covered it (bar painted but never presented)
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("void 0");
    }
    diag("open: done");
    Ok(())
}

#[tauri::command]
pub async fn diag_log(msg: String) -> Result<(), String> {
    diag(&format!("js: {msg}"));
    Ok(())
}

#[tauri::command]
pub async fn browser_back(state: State<'_, BrowserState>) -> Result<(), String> {
    step(&state, -1)
}

#[tauri::command]
pub async fn browser_forward(state: State<'_, BrowserState>) -> Result<(), String> {
    step(&state, 1)
}

fn step(state: &State<'_, BrowserState>, dir: i32) -> Result<(), String> {
    let (wv, target) = {
        let mut guard = state.0.lock().unwrap();
        let Some(b) = guard.as_mut() else { return Ok(()) };
        let idx = b.idx as i64 + dir as i64;
        if idx < 0 || idx as usize >= b.hist.len() {
            return Ok(());
        }
        b.idx = idx as usize;
        (b.webview.clone(), b.hist[b.idx].clone())
    };
    let parsed: Url = target.parse().map_err(|e| format!("{e}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(state: State<'_, BrowserState>, url: String) -> Result<(), String> {
    let parsed = parse_http(&url)?;
    let (wv, existing) = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(b) => (b.webview.clone(), true),
            None => return Ok(()),
        }
    };
    let s = parsed.to_string();
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    if existing {
        if let Some(b) = state.0.lock().unwrap().as_mut() {
            b.hist.truncate(b.idx + 1);
            b.hist.push(s);
            b.idx = b.hist.len() - 1;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_reload(state: State<'_, BrowserState>) -> Result<(), String> {
    let wv = {
        let guard = state.0.lock().unwrap();
        guard.as_ref().map(|b| (b.webview.clone(), b.hist[b.idx].clone()))
    };
    if let Some((wv, target)) = wv {
        let parsed: Url = target.parse().map_err(|e| format!("{e}"))?;
        wv.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_close(state: State<'_, BrowserState>) -> Result<(), String> {
    let wv = state.0.lock().unwrap().take().map(|b| b.webview);
    if let Some(wv) = wv {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    parse_http(&url)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// re-fit the child webview under the browser bar whenever the main window
// changes size (also fires on minimize/restore — bounds of 0 are harmless).
// Runs on the MAIN thread — clone-then-act keeps this deadlock-free against
// commands that hold nothing while calling into the webview.
pub fn on_main_resize(app: &AppHandle, size: PhysicalSize<u32>) {
    let handle = {
        let state = app.state::<BrowserState>();
        let Ok(guard) = state.0.lock() else { return };
        guard.as_ref().map(|b| (b.webview.clone(), b.top))
    };
    let Some((wv, top)) = handle else { return };
    let Some(win) = app.get_window("main") else { return };
    let Ok(scale) = win.scale_factor() else { return };
    let s = size.to_logical::<f64>(scale);
    let _ = wv.set_bounds(tauri::Rect {
        position: LogicalPosition::new(0.0, top).into(),
        size: LogicalSize::new(s.width, (s.height - top).max(0.0)).into(),
    });
}
