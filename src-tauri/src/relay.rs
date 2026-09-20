// oc-relay lifecycle for the phone-notification bridge (docs/mobile-companion.md).
// The GUI can spawn/stop the relay itself (Settings → Phone notifications →
// "Run relay on this PC") so no separate terminal is needed; the child is
// assigned to the Windows Job Object so it dies with the GUI (crash included).
// Tokens live in <config>/relay/relay-tokens.txt (the relay writes them, we
// read them back to auto-fill the desktop token + build the one-tap phone link).
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

pub struct RelayState {
    pub child: Mutex<Option<Child>>,
}

const RELAY_PORT: u16 = 8918;

#[derive(Serialize)]
pub struct RelayInfo {
    pub running: bool,
    pub pid: Option<u32>,
    pub ours: bool,
    pub local_url: String,
    pub wss_url: Option<String>,
    pub phone_page: Option<String>,
    pub desktop_token: Option<String>,
    pub phone_token: Option<String>,
    pub exe: Option<String>,
}

// bundled exe next to the GUI exe, or a dev build in the workspace relay dir
fn exe_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("oc-relay.exe"));
            out.push(dir.join("oc-relay"));
        }
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let ws = PathBuf::from(manifest).join("..").join("relay").join("target");
        out.push(ws.join("release").join("oc-relay.exe"));
        out.push(ws.join("release").join("oc-relay"));
        out.push(ws.join("debug").join("oc-relay.exe"));
        out.push(ws.join("debug").join("oc-relay"));
    }
    out
}

fn resolve_relay_exe() -> Option<PathBuf> {
    exe_candidates().into_iter().find(|p| p.is_file())
}

// relay keeps its tokens in its working directory — we spawn it with
// cwd = <config>/relay so the file survives restarts and is readable here

fn parse_tokens(txt: &str) -> (Option<String>, Option<String>) {
    let mut desktop = None;
    let mut phone = None;
    for l in txt.lines() {
        let l = l.trim();
        if desktop.is_none() && l.starts_with("ocd-") {
            desktop = Some(l.to_string());
        } else if phone.is_none() && l.starts_with("ocp-") {
            phone = Some(l.to_string());
        }
    }
    (desktop, phone)
}

fn lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

fn port_serving() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{RELAY_PORT}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn info(app: &tauri::AppHandle, state: &RelayState) -> RelayInfo {
    let ours = state
        .child
        .lock()
        .unwrap()
        .as_mut()
        .map(|c| matches!(c.try_wait(), Ok(None)))
        .unwrap_or(false);
    let running = ours || port_serving();
    let (desktop_token, phone_token) = read_tokens(app);
    let phone_page = phone_token.as_ref().and_then(|t| {
        lan_ip().map(|ip| format!("https://{ip}:{}/phone?t={}", RELAY_PORT + 1, t))
    });
    RelayInfo {
        running,
        pid: state.child.lock().unwrap().as_ref().map(|c| c.id()),
        ours,
        local_url: format!("ws://127.0.0.1:{RELAY_PORT}/ws"),
        wss_url: lan_ip().map(|ip| format!("wss://{ip}:{}/ws", RELAY_PORT + 1)),
        phone_page,
        desktop_token,
        phone_token,
        exe: resolve_relay_exe().map(|p| p.display().to_string()),
    }
}

fn read_tokens(app: &tauri::AppHandle) -> (Option<String>, Option<String>) {
    let dir = crate::platform::config_dir(app).join("relay");
    match std::fs::read_to_string(dir.join("relay-tokens.txt")) {
        Ok(txt) => parse_tokens(&txt),
        Err(_) => (None, None),
    }
}

#[tauri::command]
pub async fn relay_start(app: tauri::AppHandle, state: State<'_, RelayState>) -> Result<RelayInfo, String> {
    // already ours and alive → done
    {
        let mut g = state.child.lock().unwrap();
        if let Some(c) = g.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                drop(g);
                return Ok(info(&app, &state));
            }
        }
    }
    // foreign relay already serving this port → adopt (report running, don't spawn)
    if port_serving() {
        return Ok(info(&app, &state));
    }
    let exe = resolve_relay_exe().ok_or_else(|| {
        "oc-relay binary not found — build it: cargo build --release (in relay/)".to_string()
    })?;
    let cwd = crate::platform::config_dir(&app).join("relay");
    let _ = std::fs::create_dir_all(&cwd);
    let mut cmd = crate::platform::win_command(&exe);
    cmd.current_dir(&cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("spawn oc-relay: {e}"))?;
    // dies with the GUI (Windows Job Object) — no orphans on crash/quit
    crate::server::job::assign(&child);
    // wait briefly for the port so the first status check succeeds
    for _ in 0..20 {
        if port_serving() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    *state.child.lock().unwrap() = Some(child);
    Ok(info(&app, &state))
}

#[tauri::command]
pub async fn relay_stop(app: tauri::AppHandle, state: State<'_, RelayState>) -> Result<RelayInfo, String> {
    if let Some(mut c) = state.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(info(&app, &state))
}

#[tauri::command]
pub async fn relay_status(app: tauri::AppHandle, state: State<'_, RelayState>) -> Result<RelayInfo, String> {
    Ok(info(&app, &state))
}

#[cfg(test)]
mod tests {
    use super::parse_tokens;

    #[test]
    fn token_file_parse() {
        let (d, p) = parse_tokens("ocd-aaa\nocp-bbb\n");
        assert_eq!(d.as_deref(), Some("ocd-aaa"));
        assert_eq!(p.as_deref(), Some("ocp-bbb"));
        // phone first / desktop missing
        let (d, p) = parse_tokens("ocp-bbb\n");
        assert_eq!(d, None);
        assert_eq!(p.as_deref(), Some("ocp-bbb"));
        // garbage tolerated
        let (d, p) = parse_tokens("noise\nocp-bbb\nmore noise\n");
        assert_eq!(d, None);
        assert_eq!(p.as_deref(), Some("ocp-bbb"));
        // empty
        let (d, p) = parse_tokens("");
        assert_eq!(d, None);
        assert_eq!(p, None);
    }
}
