use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// everything lives under ~/.config/.opencode-gui/whisper/ — same root as themes.json
fn whisper_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join(".opencode-gui")
        .join("whisper")
}

fn bin_dir() -> PathBuf {
    whisper_dir().join("bin")
}

fn models_dir() -> PathBuf {
    whisper_dir().join("models")
}

fn downloads_dir() -> PathBuf {
    whisper_dir().join("downloads")
}

fn find_cli() -> Option<PathBuf> {
    for name in ["whisper-cli.exe", "main.exe"] {
        let p = bin_dir().join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[derive(serde::Serialize)]
pub struct VoiceStatus {
    bin: bool,
    models: Vec<String>,
}

#[tauri::command]
pub fn voice_status() -> VoiceStatus {
    let mut models = Vec::new();
    if let Ok(rd) = std::fs::read_dir(models_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".bin") {
                models.push(name);
            }
        }
    }
    models.sort();
    VoiceStatus {
        bin: find_cli().is_some(),
        models,
    }
}

// downloads url to <downloads>/<key>.part using the OS curl.exe — the
// webview's fetch() can't follow GitHub/HF release redirects cross-origin
// async so curl runs off the main thread — sync commands freeze the UI
#[tauri::command]
pub async fn voice_download(key: String, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("bad download url".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(downloads_dir()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("curl.exe");
    cmd.args(["-L", "--fail", "--silent", "--show-error", "--max-time", "1800", "-o"]);
    cmd.arg(&part).arg(&url);
    // release: no console flash next to the frameless window
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("failed to run curl: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&part);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("download failed: {}", err.trim()));
    }
    Ok(())
}

fn part_path(key: &str) -> Result<PathBuf, String> {
    let safe: String = key.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
    if safe.is_empty() || safe.contains("..") {
        return Err("bad download key".into());
    }
    Ok(downloads_dir().join(format!("{safe}.part")))
}

#[tauri::command]
pub async fn install_bin_finalize(key: String) -> Result<(), String> {
    let part = part_path(&key)?;
    let data = std::fs::read(&part).map_err(|e| format!("download incomplete: {e}"))?;
    let _ = std::fs::remove_file(&part);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(bin_dir()).map_err(|e| e.to_string())?;
    // flatten: release zips wrap everything in one folder ("Release/")
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
        let out = bin_dir().join(fname);
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
    }
    find_cli().ok_or_else(|| "zip extracted but no whisper-cli/main exe found".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn install_model_finalize(key: String, name: String) -> Result<(), String> {
    if !name.ends_with(".bin") || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad model name".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;
    std::fs::rename(&part, models_dir().join(&name)).or_else(|_| {
        // rename across volumes fails — fall back to copy
        let n = std::fs::copy(&part, models_dir().join(&name)).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&part);
        if n == 0 {
            return Err("empty model file".into());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn voice_remove_model(name: String) -> Result<(), String> {
    if !name.ends_with(".bin") || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad model name".into());
    }
    match std::fs::remove_file(models_dir().join(&name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// runs whisper-cli over a 16 kHz mono s16 WAV produced by the webview;
// returns the plain-text transcription (-nt strips timestamps)
#[tauri::command]
pub async fn voice_transcribe(audio: Vec<u8>, model: String) -> Result<String, String> {
    let cli = find_cli()
        .ok_or_else(|| "voice engine not installed — set it up in Settings > Voice".to_string())?;
    if !model.ends_with(".bin") || model.contains("..") {
        return Err("bad model name".into());
    }
    let mp = models_dir().join(model);
    if !mp.exists() {
        return Err(format!("model {} is not downloaded", mp.display()));
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("oc-voice-{}-{}.wav", std::process::id(), ts));
    std::fs::write(&tmp, &audio).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&cli);
    cmd.arg("-m").arg(&mp).arg("-f").arg(&tmp);
    cmd.args(["-nt", "-np"]);
    // release: CREATE_NO_WINDOW keeps a console from flashing next to the GUI;
    // dev builds inherit stderr so whisper errors show in the terminal
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW).stderr(Stdio::null());
    }
    cmd.stdout(Stdio::piped());

    let result = (|| -> Result<String, String> {
        let mut child = cmd.spawn().map_err(|e| format!("failed to run whisper-cli: {e}"))?;
        // hard cap so a wedged process can't pin the UI mic state forever
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(_) => break,
                None => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        return Err("transcription timed out".into());
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() && out.stdout.is_empty() {
            return Err(format!("whisper-cli failed ({})", out.status));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let clean = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        Ok(clean)
    })();

    let _ = std::fs::remove_file(&tmp);
    result
}
