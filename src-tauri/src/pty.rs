// integrated terminal: multiple ConPTY sessions behind xterm.js. PTYs are owned
// by Rust and survive webview re-renders — each session streams base64 chunks
// on "pty://frame" {id,g,d} and exits on "pty://exit" {id,g}. Frontend filters
// by id+gen so dead shells can't bleed into live views.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    pub gen: u64,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<u32, Arc<PtySession>>>);

const MAX_TERMS: usize = 8;

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "powershell.exe".into())
}

fn parse_shell_args(raw: Option<String>) -> Vec<String> {
    let s = match raw {
        Some(v) if !v.trim().is_empty() => v,
        _ => return Vec::new(),
    };
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
                    out.push(cur.clone());
                    cur.clear();
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

fn workdir(cwd: &str) -> std::path::PathBuf {
    let p = if cwd.is_empty() {
        std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
    } else {
        std::path::PathBuf::from(cwd)
    };
    if p.is_dir() { p } else { std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()) }
}

impl PtySession {
    pub fn kill(&self) {
        self.killed.store(true, Ordering::Relaxed);
        let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

fn kill_and_close(map: &mut HashMap<u32, Arc<PtySession>>, id: u32) {
    if let Some(old) = map.remove(&id) {
        old.kill();
    }
}

pub fn kill_all(state: &PtyState) {
    let ids: Vec<u32> = {
        let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<u32> = map.keys().copied().collect();
        for id in &ids {
            if let Some(old) = map.remove(id) {
                old.kill();
            }
        }
        ids
    };
    if !ids.is_empty() {
        std::thread::sleep(Duration::from_millis(90));
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: u32,
    cwd: String,
    gen: u64,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    args: Option<Vec<String>>,
    shell_args: Option<String>,
) -> Result<(), String> {
    let shell_param = shell;
    // don't hold PtyState lock during ConPTY creation — it janks the UI when 3-4 terminals start at once
    let needs_sleep = {
        let mut map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
        if id == 0 {
            return Err("invalid terminal id".into());
        }
        if map.contains_key(&id) {
            kill_and_close(&mut map, id);
            true
        } else if map.len() >= MAX_TERMS {
            return Err(format!("max terminals ({MAX_TERMS}) reached"));
        } else {
            false
        }
    };
    if needs_sleep {
        std::thread::sleep(Duration::from_millis(90));
    }

    let init_cols = if cols >= 2 && cols <= 1000 { cols } else { 80 };
    let init_rows = if rows >= 2 && rows <= 1000 { rows } else { 24 };
    let pair = native_pty_system()
        .openpty(PtySize { rows: init_rows, cols: init_cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let shell_cmd = match shell_param {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => default_shell(),
    };
    let mut extra_args: Vec<String> = args.unwrap_or_default();
    extra_args.extend(parse_shell_args(shell_args));
    // validate absolute/relative paths early for clearer errors
    if shell_cmd.contains('\\') || shell_cmd.contains('/') {
        let p = std::path::Path::new(&shell_cmd);
        if !p.exists() {
            return Err(format!("shell not found: {}", shell_cmd));
        }
    }
    let mut cmd = CommandBuilder::new(shell_cmd.clone());
    let low = shell_cmd.to_lowercase();
    if (low.contains("powershell") || low.contains("pwsh")) && !extra_args.iter().any(|a| a == "-NoLogo" || a == "-NoExit") {
        cmd.arg("-NoLogo");
        cmd.arg("-NoExit");
    }
    for a in &extra_args {
        cmd.arg(a);
    }
    cmd.cwd(workdir(&cwd));
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("{}: {e}", shell_cmd))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = Arc::new(PtySession {
        gen,
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        killed: Arc::new(AtomicBool::new(false)),
    });

    let emitter = app.clone();
    let killed = session.killed.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut total = 0usize;
        use base64::Engine as _;
        let mut reason = "eof";
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    let _ = emitter.emit(
                        "pty://frame",
                        serde_json::json!({
                            "id": id,
                            "g": gen,
                            "d": base64::engine::general_purpose::STANDARD.encode(&buf[..n])
                        }),
                    );
                }
                Err(_) => {
                    if killed.load(Ordering::Relaxed) {
                        reason = "killed";
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        eprintln!("[pty] reader exit id={id} gen={gen} reason={reason} total={total}B");
        let _ = emitter.emit("pty://exit", serde_json::json!({ "id": id, "g": gen }));
    });

    {
        let mut map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&id) {
            kill_and_close(&mut map, id);
        } else if map.len() >= MAX_TERMS {
            return Err(format!("max terminals ({MAX_TERMS}) reached"));
        }
        map.insert(id, session);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ses) = map.get(&id) {
        ses.writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    let map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ses) = map.get(&id) {
        ses.master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32, gen: u64) -> Result<(), String> {
    let needs_sleep = {
        let mut map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(&id).map(|s| s.gen) == Some(gen) {
            kill_and_close(&mut map, id);
            true
        } else if map.contains_key(&id) && gen == 0 {
            // gen 0 = force kill regardless of gen (used for bulk cleanup)
            kill_and_close(&mut map, id);
            true
        } else {
            false
        }
    };
    if needs_sleep {
        std::thread::sleep(Duration::from_millis(90));
    }
    Ok(())
}
