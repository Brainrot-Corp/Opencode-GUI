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

fn shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "powershell.exe".into())
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
        std::thread::sleep(Duration::from_millis(150));
    }
}

pub fn kill_all(state: &PtyState) {
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let ids: Vec<u32> = map.keys().copied().collect();
    let had = !ids.is_empty();
    for id in ids {
        if let Some(old) = map.remove(&id) {
            old.kill();
        }
    }
    if had {
        std::thread::sleep(Duration::from_millis(150));
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
) -> Result<(), String> {
    let mut map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    if id == 0 {
        return Err("invalid terminal id".into());
    }
    if map.contains_key(&id) {
        // idempotent replace — stale frontend retry or HMR remount shouldn't hard-fail;
        // kill the existing ConPTY and allow the new spawn to take its slot
        kill_and_close(&mut map, id);
    } else if map.len() >= MAX_TERMS {
        return Err(format!("max terminals ({MAX_TERMS}) reached"));
    }

    let init_cols = if cols >= 2 && cols <= 1000 { cols } else { 80 };
    let init_rows = if rows >= 2 && rows <= 1000 { rows } else { 24 };
    let pair = native_pty_system()
        .openpty(PtySize { rows: init_rows, cols: init_cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let shell_cmd = shell();
    let mut cmd = CommandBuilder::new(shell_cmd.clone());
    if shell_cmd.to_lowercase().contains("powershell") || shell_cmd.to_lowercase().contains("pwsh") {
        cmd.arg("-NoLogo");
        cmd.arg("-NoExit");
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

    map.insert(id, session);
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
    let mut map = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    if map.get(&id).map(|s| s.gen) == Some(gen) {
        kill_and_close(&mut map, id);
    } else if map.contains_key(&id) && gen == 0 {
        // gen 0 = force kill regardless of gen (used for bulk cleanup)
        kill_and_close(&mut map, id);
    }
    Ok(())
}
