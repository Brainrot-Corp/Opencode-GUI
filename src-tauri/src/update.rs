use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// portable self-updater: the release exes (opencode-gui.exe + opencode.exe
// sidecar) are downloaded, each verified against its GitHub asset sha256 and
// staged; the swap happens in the RunEvent::Exit handler, after the server
// child is killed — Windows allows renaming the running exe, so no helper
// process or install-time machinery is needed
static STAGED: Mutex<Option<PathBuf>> = Mutex::new(None);
static ARMED: AtomicBool = AtomicBool::new(false);

fn staging_dir(version: &str) -> PathBuf {
    std::env::temp_dir().join("oc-update").join(version)
}

fn sha256_of(path: &PathBuf) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    h.update(&data);
    Ok(format!("{:x}", h.finalize()))
}

// which portable flavor this build is — decides which release zip the
// updater downloads (noglass = Windows 10 build, default = Windows 11)
#[tauri::command]
pub fn build_flavor() -> &'static str {
    if cfg!(feature = "noglass") {
        "win10"
    } else {
        "win11"
    }
}

// curl.exe + sha256 + zip extraction — same download pipeline as the voice
// installs; staging under %TEMP%\oc-update\<version> keeps partial/replaced
// releases from colliding. The release zip holds both portable exes
// (opencode-gui.exe + opencode.exe sidecar).
#[tauri::command]
pub async fn update_download(url: String, sha256: String, version: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("bad download url".into());
    }
    let dir = staging_dir(&version);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip_path = dir.join("update.zip");

    let mut cmd = std::process::Command::new("curl.exe");
    cmd.args(["-L", "--fail", "--silent", "--show-error", "--max-time", "1800", "-o"]);
    cmd.arg(&zip_path).arg(&url);
    // release: no console flash next to the frameless window
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    let out = cmd.output().map_err(|e| format!("failed to run curl: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&dir);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("download failed: {}", err.trim()));
    }

    let actual = sha256_of(&zip_path)?;
    if !actual.eq_ignore_ascii_case(&sha256) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("checksum mismatch — download corrupted or tampered".into());
    }

    let data = std::fs::read(&zip_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&zip_path);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    // flatten: both zips pack the exes at the root; tolerate wrapper dirs
    let (mut has_exe, mut has_sidecar) = (false, false);
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name();
        let fname = name.rsplit(['/', '\\']).next().unwrap_or(name);
        if fname.is_empty() || fname.starts_with('.') {
            continue;
        }
        if fname.eq_ignore_ascii_case("opencode-gui.exe") {
            has_exe = true;
        }
        if fname.eq_ignore_ascii_case("opencode.exe") {
            has_sidecar = true;
        }
        let mut w = std::fs::File::create(dir.join(fname)).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
    }
    if !has_exe || !has_sidecar {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("release zip missing opencode-gui.exe or opencode.exe".into());
    }

    *STAGED.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    Ok(())
}

// debug: stage a local folder containing opencode-gui.exe (and optionally
// opencode.exe) as an update. Folder can be a direct file path to the exe
// as well — we normalize to its parent. Version defaults to "debug-local"
// if empty. Verifies the exe exists and stages it under %TEMP%\oc-update.
#[tauri::command]
pub fn update_stage_local(folder: String, version: String) -> Result<(), String> {
    let raw = folder.trim();
    if raw.is_empty() {
        return Err("empty folder path".into());
    }
    let mut src_dir = PathBuf::from(raw);
    // allow direct file path to exe (user pastes exe path instead of folder)
    if src_dir.is_file() {
        if let Some(parent) = src_dir.parent() {
            src_dir = parent.to_owned();
        }
    }
    if !src_dir.is_dir() {
        return Err(format!("not a folder: {}", src_dir.display()));
    }
    // find opencode-gui.exe case-insensitively inside folder (tolerate wrapper)
    let mut gui_src: Option<PathBuf> = None;
    let mut sidecar_src: Option<PathBuf> = None;
    for entry in std::fs::read_dir(&src_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("opencode-gui.exe") {
                gui_src = Some(p);
            } else if name.eq_ignore_ascii_case("opencode.exe") {
                sidecar_src = Some(p);
            }
        }
    }
    let gui_src = gui_src.ok_or_else(|| format!("{} missing opencode-gui.exe", src_dir.display()))?;
    let ver = if version.trim().is_empty() {
        "debug-local".to_string()
    } else {
        version.trim().to_string()
    };
    let dir = staging_dir(&ver);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&gui_src, dir.join("opencode-gui.exe")).map_err(|e| e.to_string())?;
    if let Some(side) = sidecar_src {
        let _ = std::fs::copy(&side, dir.join("opencode.exe"));
    } else {
        // fallback: reuse current sidecar so swap doesn't leave it missing
        if let Ok(cur) = std::env::current_exe() {
            if let Some(exe_dir) = cur.parent() {
                let cur_side = exe_dir.join("opencode.exe");
                if cur_side.exists() {
                    let _ = std::fs::copy(&cur_side, dir.join("opencode.exe"));
                }
            }
        }
    }
    // ensure at least gui exists (we just copied)
    if !dir.join("opencode-gui.exe").exists() {
        return Err("staging failed".into());
    }
    *STAGED.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    Ok(())
}

// arm the staged update and exit — the RunEvent::Exit handler does the swap
// and relaunches the new exe
#[tauri::command]
pub fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
    match staged.as_ref() {
        Some(dir) if dir.join("opencode-gui.exe").exists() => {}
        _ => return Err("no update staged".into()),
    }
    ARMED.store(true, Ordering::Relaxed);
    app.exit(0);
    Ok(())
}

// rename-then-move with a retry loop: the sidecar's image file stays locked
// until the killed server process fully exits, which can lag the kill
// ponytail: 5s of retries, per-file waits if a hung child ever needs more
fn move_file(src: &PathBuf, dst: &PathBuf) {
    for _ in 0..50 {
        if std::fs::rename(src, dst).is_ok() {
            return;
        }
        // rename across volumes fails — copy fallback
        if std::fs::copy(src, dst).is_ok() {
            let _ = std::fs::remove_file(src);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

pub fn cleanup_old() {
    if let Ok(cur) = std::env::current_exe() {
        if let Some(dir) = cur.parent() {
            let _ = std::fs::remove_file(dir.join("opencode-gui.old.exe"));
        }
    }
}

fn trace(msg: &str) {
    let _ = (|| -> std::io::Result<()> {
        use std::io::Write;
        let p = std::env::temp_dir().join("oc-update-trace.log");
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();
        writeln!(f, "[{ts}] {msg}").ok();
        Ok(())
    })();
}

pub fn apply_on_exit() {
    // trace to %TEMP%\oc-update-trace.log for field diagnosis (portable + debug local)
    trace("apply_on_exit enter");
    if !ARMED.load(Ordering::Relaxed) {
        trace("apply_on_exit: not armed");
        return;
    }
    let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(dir) = staged.clone() else { trace("apply_on_exit: no staged dir"); return };
    trace(&format!("staged dir: {}", dir.display()));
    let Some(cur) = std::env::current_exe().ok() else { trace("apply_on_exit: current_exe failed"); return };
    trace(&format!("cur exe: {}", cur.display()));
    let Some(exe_dir) = cur.parent().map(|p| p.to_owned()) else { trace("apply_on_exit: no parent"); return };
    trace(&format!("exe_dir: {}", exe_dir.display()));

    // rename the running exe aside, then drop the new files in — copying
    // over a running exe is denied, renaming it is fine
    let old = exe_dir.join("opencode-gui.old.exe");
    let _ = std::fs::remove_file(&old);
    match std::fs::rename(&cur, &old) {
        Ok(_) => trace("rename cur -> old ok"),
        Err(e) => { trace(&format!("rename failed (MSI/locked): {e}")); return; }
    }
    move_file(&dir.join("opencode-gui.exe"), &exe_dir.join("opencode-gui.exe"));
    trace(&format!("move_file gui -> {} exists={}", exe_dir.join("opencode-gui.exe").display(), exe_dir.join("opencode-gui.exe").exists()));
    move_file(&dir.join("opencode.exe"), &exe_dir.join("opencode.exe"));
    trace(&format!("move_file sidecar -> {} exists={}", exe_dir.join("opencode.exe").display(), exe_dir.join("opencode.exe").exists()));

    let _ = std::fs::remove_dir_all(&dir);
    // the old exe's image may still be held open until this process fully
    // exits — the new instance cleans it up on launch via cleanup_old()

    // Relaunch must survive the single-instance mutex race: the new process
    // started inside RunEvent::Exit still sees the old instance's lock held
    // on Win10 (slower teardown — AV, WebView2) and would exit as a
    // "second instance" that merely signals the old window. Wait for the
    // parent PID to disappear (mutex released), then start detached.
    // Batch-based wait is the most compatible across Win10/11 locales and
    // execution-policy lockdowns; PowerShell is fallback only.
    let exe_path = exe_dir.join("opencode-gui.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        let exe_quoted = format!("\"{}\"", exe_path.display());
        trace(&format!("exe_path: {} quoted={}", exe_path.display(), exe_quoted));
        // 1.5.5 simply did `Command::new(exe).spawn()` with no wait — worked on Win11
        // where the single-instance mutex is released quickly, but failed on Win10
        // where AV/WebView2 holds it ~1-2s. The tasklist-polling batch added later
        // broke entirely (missing parens caused infinite `goto wait` loop, plus
        // locale-dependent `tasklist`/`find` failures). Fixed-delay batch avoids
        // all of that: ~2.5s ping delay then `start --new-instance` bypasses the
        // mutex entirely. Matches 1.5.5's direct spawn semantics but survives Win10.
        let batch_path = std::env::temp_dir().join("oc-relaunch.bat");
        let batch = format!(
            "@echo off\r\nping -n 4 127.0.0.1 >nul\r\nstart \"\" {} --new-instance\r\n(goto) 2>nul & del \"%~f0\"\r\n",
            exe_quoted
        );
        trace(&format!("batch_path: {} batch_len={}", batch_path.display(), batch.len()));
        let mut spawned = false;
        if std::fs::write(&batch_path, &batch).is_ok() {
            trace("batch write ok");
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", &batch_path.to_string_lossy().to_string()]);
            cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            match cmd.spawn() {
                Ok(_) => { trace("batch spawn ok"); spawned = true; }
                Err(e) => trace(&format!("batch spawn failed: {e}")),
            }
        } else {
            trace("batch write failed");
        }
        if !spawned {
            trace("batch not spawned, trying powershell");
            // Fallback: fixed 2s sleep then Start-Process --new-instance (same semantics as batch)
            let exe_str = exe_path.to_string_lossy().replace('\'', "''");
            let ps_cmd = format!(
                "Start-Sleep -Seconds 2; Start-Process -FilePath '{}' -ArgumentList '--new-instance'",
                exe_str
            );
            trace(&format!("ps_cmd: {ps_cmd}"));
            let mut cmd = std::process::Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_cmd,
            ]);
            cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            match cmd.spawn() {
                Ok(_) => { trace("powershell spawn ok"); spawned = true; }
                Err(e) => {
                    trace(&format!("powershell spawn failed: {e}"));
                    let mut alt = std::process::Command::new("pwsh");
                    alt.args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-WindowStyle",
                        "Hidden",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-Command",
                        &ps_cmd,
                    ]);
                    alt.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                    match alt.spawn() {
                        Ok(_) => { trace("pwsh spawn ok"); spawned = true; }
                        Err(e2) => {
                            trace(&format!("pwsh spawn failed: {e2}"));
                            // Last resort: direct detached launch (no delay)
                            let mut fallback = std::process::Command::new(&exe_path);
                            fallback.arg("--new-instance");
                            fallback.creation_flags(
                                CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                            );
                            match fallback.spawn() {
                                Ok(_) => { trace("direct fallback spawn ok"); spawned = true; }
                                Err(e3) => trace(&format!("direct fallback spawn failed: {e3}")),
                            }
                        }
                    }
                }
            }
        }
        trace(&format!("apply_on_exit done spawned={spawned}"));
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new(&exe_path);
        let _ = cmd.spawn();
    }
}
