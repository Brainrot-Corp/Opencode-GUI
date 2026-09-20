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

// streams the file through the hash so a 300 MB release zip never lands in
// RAM twice (audit: the old version read the whole file for sha256 AND again
// for zip parsing)
fn sha256_of_reader(r: &mut dyn std::io::Read) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

// which flavor this build is — Windows uses noglass/win11, other OS return os-arch
#[tauri::command]
pub fn build_flavor() -> &'static str {
    if cfg!(feature = "noglass") {
        "win10"
    } else if cfg!(target_os = "macos") {
        "macos-arm64"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") { "linux-arm64" } else { "linux-x64" }
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
    if !cfg!(windows) {
        return Err("auto-update only available on Windows".into());
    }
    if !url.starts_with("https://") {
        return Err("bad download url".into());
    }
    let dir = staging_dir(&version);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // curl can run up to 30 min and the zip pass streams ~300 MB — run the
    // whole pipeline on the blocking pool instead of pinning an async worker
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let zip_path = dir.join("update.zip");

        // curl can run up to 30 min — platform::curl_download enforces the
        // timeout, cleans a partial file on failure and hides the console in
        // release builds. (No size cap here: the release zip's sha256 gate
        // + streaming extraction bound memory; cap would need a per-release
        // constant.)
        crate::platform::curl_download(&url, &zip_path, u64::MAX)?;

        // pass 1: sha256 streamed off disk
        let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let actual = sha256_of_reader(&mut std::io::BufReader::new(file))?;
        if !actual.eq_ignore_ascii_case(&sha256) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err("checksum mismatch — download corrupted or tampered".into());
        }

        // pass 2: extraction streamed via File+BufReader (no read-to-RAM)
        let (mut has_exe, mut has_sidecar) = (false, false);
        {
            let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
            let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
            // flatten: both zips pack the exes at the root; tolerate wrapper dirs
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
        }
        let _ = std::fs::remove_file(&zip_path);
        if !has_exe || !has_sidecar {
            let _ = std::fs::remove_dir_all(&dir);
            return Err("release zip missing opencode-gui.exe or opencode.exe".into());
        }

        *STAGED.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
        Ok(())
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))?
}

// debug: stage a local folder containing opencode-gui.exe (and optionally
// opencode.exe) as an update. Folder can be a direct file path to the exe
// as well — we normalize to its parent. Version defaults to "debug-local"
// if empty. Verifies the exe exists and stages it under %TEMP%\oc-update.
// Debug-only: release builds get an Err stub (zero staging code ships) —
// the invoke_handler entry in lib.rs:2105 can be dropped later.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn update_stage_local(folder: String, version: String) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("local staging only on Windows".into());
    }
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

// release stub — keeps the lib.rs generate_handler! entry compiling while
// shipping none of the staging code; same signature/arg names as the debug
// command so invoke({folder, version}) still resolves
#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn update_stage_local(folder: String, version: String) -> Result<(), String> {
    let _ = (&folder, &version);
    Err("update_stage_local is debug-only".into())
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
// until every process running it exits — the killed server child, but also
// other windows' servers and pty shells running the opencode CLI
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
    // silent give-up used to leave the OLD exe in place unnoticed — the
    // relaunched app then ran the old version. Surface it.
    trace(&format!(
        "move_file gave up: {} -> {}",
        src.display(),
        dst.display()
    ));
}

pub fn cleanup_old() {
    if let Ok(cur) = std::env::current_exe() {
        if let Some(dir) = cur.parent() {
            let _ = std::fs::remove_file(dir.join("opencode-gui.old.exe"));
            let _ = std::fs::remove_file(dir.join("opencode.old.exe"));
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

#[cfg(all(test, windows))]
mod tests {
    // regression for the "reopened as old version" bug: replacing/copying
    // over a RUNNING image is denied, renaming it aside is not. Spawns a
    // copy of cmd.exe as a stand-in sidecar and replays the swap steps.
    #[test]
    fn swap_running_image_needs_rename_aside() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("oc-update-selftest");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src_cmd = r"C:\Windows\System32\cmd.exe";
        let running = dir.join("A.exe");
        let spare = dir.join("B.exe");
        std::fs::copy(src_cmd, &running).unwrap();
        std::fs::copy(src_cmd, &spare).unwrap();
        let mut child = std::process::Command::new(&running)
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        // wait until the image is actually loaded (CreateProcess returns
        // before the loader finishes mapping)
        std::thread::sleep(std::time::Duration::from_millis(500));
        // old behavior: replace over the running image — must FAIL
        assert!(std::fs::rename(&spare, &running).is_err(), "replace over a running image should be denied");
        // fix: rename-aside while running, then move the new one in
        let aside = dir.join("A.old.exe");
        std::fs::rename(&running, &aside).expect("rename-aside of a running image must succeed");
        std::fs::rename(&spare, &running).expect("move into vacated path must succeed");
        child.kill().unwrap();
        let _ = child.wait();
        // cleanup marker so later runs see a fresh dir
        let mut probe = std::fs::OpenOptions::new().append(true).open(std::env::temp_dir().join("oc-update-trace.log")).unwrap();
        let _ = writeln!(probe, "[selftest] swap_running_image_needs_rename_aside ok");
        let _ = std::fs::remove_dir_all(&dir);
    }
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
    // sidecar: rename the old one aside first (allowed even while it's still
    // running — other windows' servers or a pty `opencode` can hold the image
    // past our own child.kill()), then move the new one into the vacated
    // path. Copying/replacing over a running image is denied, renaming is not.
    let side_old = exe_dir.join("opencode.old.exe");
    let _ = std::fs::remove_file(&side_old);
    match std::fs::rename(&exe_dir.join("opencode.exe"), &side_old) {
        Ok(_) => trace("rename sidecar -> old ok"),
        Err(e) => trace(&format!("rename sidecar aside failed (not running?): {e}")),
    }
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
        // 2.0.5+: the GUI puts itself in its own KILL_ON_JOB_CLOSE job (server.rs
        // job::assign); helpers spawned while dying would inherit that job and
        // be killed when the old process's last job handle closes — break away
        // so the relaunch survives (BREAKAWAY_OK is set on the job)
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let exe_quoted = format!("\"{}\"", exe_path.display());
        trace(&format!("exe_path: {} quoted={}", exe_path.display(), exe_quoted));
        // 1.5.5 simply did `Command::new(exe).spawn()` with no wait — worked on Win11
        // where the single-instance mutex is released quickly, but failed on Win10
        // where AV/WebView2 holds it ~1-2s. The tasklist-polling batch added later
        // broke entirely (missing parens caused infinite `goto wait` loop, plus
        // locale-dependent `tasklist`/`find` failures). Fixed-delay batch avoids
        // all of that: ~2.5s ping delay then `start --new-instance` bypasses the
        // mutex entirely. Matches 1.5.5's direct spawn semantics but survives Win10.
        // --restore-workspace: the old process is dead, so this window adopts the
        // persisted primary workspace instead of booting blank like a secondary.
        let batch_path = std::env::temp_dir().join("oc-relaunch.bat");
        let batch = format!(
            "@echo off\r\nping -n 4 127.0.0.1 >nul\r\nstart \"\" {} --new-instance --restore-workspace\r\n(goto) 2>nul & del \"%~f0\"\r\n",
            exe_quoted
        );
        trace(&format!("batch_path: {} batch_len={}", batch_path.display(), batch.len()));
        let mut spawned = false;
        if std::fs::write(&batch_path, &batch).is_ok() {
            trace("batch write ok");
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", &batch_path.to_string_lossy().to_string()]);
            cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
            match cmd.spawn() {
                Ok(_) => { trace("batch spawn ok"); spawned = true; }
                Err(e) => trace(&format!("batch spawn failed: {e}")),
            }
        } else {
            trace("batch write failed");
        }
        if !spawned {
            // batch write/spawn failed — last resort: direct detached launch
            // (no delay; the old powershell/pwsh tiers were cut — the batch
            // covers the mutex race and direct spawn covers a failed batch)
            trace("batch not spawned, trying direct spawn");
            let mut fallback = std::process::Command::new(&exe_path);
            fallback.arg("--new-instance");
            fallback.arg("--restore-workspace");
            fallback.creation_flags(
                CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
            );
            match fallback.spawn() {
                Ok(_) => { trace("direct fallback spawn ok"); spawned = true; }
                Err(e) => trace(&format!("direct fallback spawn failed: {e}")),
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