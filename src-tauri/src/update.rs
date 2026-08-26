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

#[derive(serde::Deserialize)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub sha256: String,
}

// curl.exe + sha256 per asset — same download pipeline as the voice
// installs; staging under %TEMP%\oc-update\<version> keeps partial/replaced
// releases from colliding
#[tauri::command]
pub async fn update_download(
    assets: Vec<UpdateAsset>,
    version: String,
) -> Result<(), String> {
    if assets.is_empty() {
        return Err("no update assets".into());
    }
    let dir = staging_dir(&version);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for a in &assets {
        if !a.url.starts_with("https://") {
            let _ = std::fs::remove_dir_all(&dir);
            return Err("bad download url".into());
        }
        // asset names come straight from GitHub — reject anything that could
        // escape the staging dir
        if a.name.contains('/') || a.name.contains('\\') || a.name.contains("..") {
            let _ = std::fs::remove_dir_all(&dir);
            return Err("bad asset name".into());
        }
        let dest = dir.join(&a.name);
        let mut cmd = std::process::Command::new("curl.exe");
        cmd.args(["-L", "--fail", "--silent", "--show-error", "--max-time", "1800", "-o"]);
        cmd.arg(&dest).arg(&a.url);
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
        let actual = sha256_of(&dest)?;
        if !actual.eq_ignore_ascii_case(&a.sha256) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "checksum mismatch for {} — download corrupted or tampered",
                a.name
            ));
        }
    }
    if !dir.join("opencode-gui.exe").exists() || !dir.join("opencode.exe").exists() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("release is missing opencode-gui.exe or opencode.exe".into());
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
    let _ = std::fs::remove_file(&old);

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
