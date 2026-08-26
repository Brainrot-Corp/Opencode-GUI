// integrated terminal: one ConPTY session behind xterm.js. The PTY is owned
// by Rust and survives webview re-renders — the panel only mounts/unmounts
// visually. Output streams to the frontend as base64 chunks on "pty://out"
// (arbitrary bytes can't ride a JSON event intact, and UTF-8 splits across
// read boundaries), exit signals on "pty://exit".
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<Option<std::sync::Arc<PtySession>>>);

fn shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "powershell.exe".into())
}

// empty/missing dir → home, mirroring git.rs workdir
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
        let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

// replaces any live session (kill first) with a fresh shell at cwd. `gen`
// tags every byte this session will ever emit — the frontend drops frames
// from superseded generations, so a slow-dying shell can't bleed its output
// (banners included) into the current session's view
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    gen: u64,
) -> Result<(), String> {
    let mut slot = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = slot.take() {
        old.kill();
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(shell());
    cmd.cwd(workdir(&cwd));
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("{}: {e}", shell()))?;
    // slave must drop before reads EOF correctly on exit
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = std::sync::Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    });

    // coalesce reads into ≥8ms frames (or 64KB) so fast output doesn't flood
    // IPC. A read error is NOT death: ConPTY aborts outstanding reads on
    // resize, so retry until the child process is really gone — otherwise
    // every drag of the size handle would "exit" the shell
    let emitter = app.clone();
    let reader_session = session.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut last = Instant::now();
        use base64::Engine as _;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    if pending.len() >= 64 * 1024 || last.elapsed() >= Duration::from_millis(8) {
                        let _ = emitter.emit(
                            "pty://frame",
                            serde_json::json!({
                                "g": gen,
                                "d": base64::engine::general_purpose::STANDARD.encode(&pending)
                            }),
                        );
                        pending.clear();
                        last = Instant::now();
                    }
                }
                Err(_) => {
                    let dead = reader_session
                        .child
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .try_wait()
                        .map(|o| o.is_some())
                        .unwrap_or(true);
                    if dead {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        if !pending.is_empty() {
            let _ = emitter.emit(
                "pty://frame",
                serde_json::json!({
                    "g": gen,
                    "d": base64::engine::general_purpose::STANDARD.encode(&pending)
                }),
            );
        }
        let _ = emitter.emit("pty://exit", serde_json::json!({ "g": gen }));
    });

    *slot = Some(session);
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    match &*state.inner().0.lock().unwrap_or_else(|e| e.into_inner()) {
        Some(ses) => ses
            .writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string()),
        None => Ok(()), // dead/never-spawned session — keystrokes go nowhere
    }
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Ok(()); // fit addon measures while collapsed
    }
    match &*state.inner().0.lock().unwrap_or_else(|e| e.into_inner()) {
        Some(ses) => ses
            .master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

// user-invoked restart (or teardown): kills the shell; the reader thread
// emits pty://exit on its own
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>) -> Result<(), String> {
    if let Some(ses) = state.inner().0.lock().unwrap_or_else(|e| e.into_inner()).take() {
        ses.kill();
    }
    Ok(())
}
