// integrated terminal: one ConPTY session behind xterm.js. The PTY is owned
// by Rust and survives webview re-renders — the panel only mounts/unmounts
// visually. Output streams to the frontend as base64 chunks on "pty://out"
// (arbitrary bytes can't ride a JSON event intact, and UTF-8 splits across
// read boundaries), exit signals on "pty://exit".
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    gen: u64,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    // set just before the child is killed. The reader thread owns only a clone
    // of this flag (NOT the session — holding the session would keep the
    // ConPTY master alive and its blocking read would never see EOF after a
    // kill). Set + master dropped = ClosePseudoConsole = the pending read
    // unblocks and the reader exits.
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<Option<Arc<PtySession>>>);

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
        self.killed.store(true, Ordering::Relaxed);
        let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

// takes the live session out of the slot, marks it killed and terminates the
// child. Dropping the returned Arc runs the master's Drop → ClosePseudoConsole
// → the old reader's blocked read unblocks with EOF and the thread exits, so
// the ConPTY is fully torn down before the caller continues.
fn kill_and_close(slot: &mut Option<Arc<PtySession>>) {
    if let Some(old) = slot.take() {
        old.kill();
        // ClosePseudoConsole returns before the conhost has fully detached;
        // a fresh CreatePseudoConsole in that window can come up wedged (the
        // shell starts but never delivers output to the master). Give the
        // old console host a beat to finish tearing down.
        std::thread::sleep(Duration::from_millis(150));
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
    kill_and_close(&mut slot);

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let shell_cmd = shell();
    let mut cmd = CommandBuilder::new(shell_cmd.clone());
    if shell_cmd.to_lowercase().contains("powershell") || shell_cmd.to_lowercase().contains("pwsh") {
        cmd.arg("-NoLogo");
        cmd.arg("-NoExit");
    }
    cmd.cwd(workdir(&cwd));
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("{}: {e}", shell_cmd))?;
    // slave must drop before reads EOF correctly on exit
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

    // emits one frame per read (≤8KB). The old coalescing (≥64KB or ≥8ms
    // elapsed, checked only on the NEXT read) held a lone startup burst in
    // pending forever — a fresh shell wrote its whole prompt in one read and
    // no frame was ever emitted, so reloads looked like they produced no
    // output. The frontend highlighter already reassembles UTF-8 and escape
    // sequences split across frames.
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
        eprintln!("[pty] reader exit gen={gen} reason={reason} total={total}B");
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
// emits pty://exit on its own. `gen` must match the session's spawn gen —
// a stale kill from a superseded panel must NOT be able to kill the session
// that replaced it (reload = remount races teardown-kill vs fresh-spawn)
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, gen: u64) -> Result<(), String> {
    let mut slot = state.inner().0.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().map(|s| s.gen) == Some(gen) {
        kill_and_close(&mut slot);
    }
    Ok(())
}
