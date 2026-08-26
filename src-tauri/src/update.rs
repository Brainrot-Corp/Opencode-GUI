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

pub fn apply_on_exit() {
    if !ARMED.load(Ordering::Relaxed) {
        return;
    }
    let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(dir) = staged else { return };
    let Some(cur) = std::env::current_exe().ok() else { return };
    let Some(exe_dir) = cur.parent().map(|p| p.to_owned()) else { return };

    // rename the running exe aside, then drop the new files in — copying
    // over a running exe is denied, renaming it is fine
    let old = exe_dir.join("opencode-gui.old.exe");
    let _ = std::fs::remove_file(&old);
    if std::fs::rename(&cur, &old).is_err() {
        // e.g. MSI installs under Program Files — cannot self-update
        return;
    }
    move_file(&dir.join("opencode-gui.exe"), &exe_dir.join("opencode-gui.exe"));
    move_file(&dir.join("opencode.exe"), &exe_dir.join("opencode.exe"));

    let _ = std::fs::remove_dir_all(&dir);
    // the old exe's image may still be held open until this process fully
    // exits — the new instance cleans it up on launch via cleanup_old()

    let mut cmd = std::process::Command::new(exe_dir.join("opencode-gui.exe"));
    cmd.args(std::env::args().skip(1));
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd.spawn();
}
