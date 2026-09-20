// Voice download + install finalizers: curl download pipeline, whisper
// engine/model zip handling, Kokoro model/voice/CUDA-pack installs, and the
// "clean state" wipe.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::stt::{bin_dir, bin_gpu_dir, find_cli_in, models_dir, whisper_dir};
use super::tts::{clear_kokoro_cache, kokoro_dir, kokoro_gpu_dir, kokoro_model_path, kokoro_voice_path, kokoro_voices_dir, kokoro_voices_path};

// download size cap for voice engine/model fetches — enforced by curl
// --max-filesize and re-checked after download
pub(crate) const DOWNLOAD_CAP: u64 = 2 * 1024 * 1024 * 1024;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) fn unique_temp_path(prefix: &str, ext: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tid = format!("{:?}", std::thread::current().id());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    ts.hash(&mut hasher);
    seq.hash(&mut hasher);
    pid.hash(&mut hasher);
    tid.hash(&mut hasher);
    let rnd = hasher.finish() & 0xffff;
    std::env::temp_dir().join(format!("{prefix}-{pid}-{ts}-{seq:04}-{rnd:04x}.{ext}"))
}

pub(crate) fn downloads_dir() -> PathBuf {
    whisper_dir().join("downloads")
}

pub(crate) fn part_path(key: &str) -> Result<PathBuf, String> {
    let safe: String = key.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
    if safe.is_empty() || safe.contains("..") {
        return Err("bad download key".into());
    }
    Ok(downloads_dir().join(format!("{safe}.part")))
}

// rename across volumes fails — fall back to copy + remove of the source
// (shared by the model/kokoro/voice install finalizers)
pub(crate) fn rename_or_copy(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let n = std::fs::copy(from, to).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(from);
    if n == 0 {
        return Err("empty file".into());
    }
    Ok(())
}

// wipes the entire voice store — whisper engine + models, downloads, kokoro
// model + voices and legacy piper. Used by the settings "Clean state" reset
#[tauri::command]
pub async fn voice_remove_all() -> Result<(), String> {
    let _ = std::fs::remove_dir_all(whisper_dir());
    let _ = std::fs::remove_dir_all(kokoro_dir());
    let _ = std::fs::remove_dir_all(super::stt::whisper_dir().join("piper"));
    // whisper_dir removal already covers downloads, but ensure kokoro/piper are gone
    Ok(())
}

// downloads url to <downloads>/<key>.part using the OS curl — the webview's
// fetch() can't follow GitHub/HF release redirects. curl can run up to 30
// min, so it runs on the blocking pool via platform::curl_download.
#[tauri::command]
pub async fn voice_download(key: String, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("bad download url".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(downloads_dir()).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::platform::curl_download(&url, &part, DOWNLOAD_CAP)
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))?
}

#[tauri::command]
pub async fn install_bin_finalize(key: String, gpu: Option<bool>) -> Result<(), String> {
    let part = part_path(&key)?;
    // EH-12: cap size and stream via File+BufReader instead of read whole file (OOM on 400MB)
    let meta = std::fs::metadata(&part).map_err(|e| format!("download incomplete: {e}"))?;
    if meta.len() > DOWNLOAD_CAP {
        let _ = std::fs::remove_file(&part);
        return Err("download too large (cap 2G)".into());
    }
    if meta.len() == 0 {
        return Err("empty download".into());
    }
    let dest = if gpu.unwrap_or(false) {
        bin_gpu_dir()
    } else {
        bin_dir()
    };
    let file = std::fs::File::open(&part).map_err(|e| format!("download incomplete: {e}"))?;
    let reader = std::io::BufReader::new(file);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
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
        let out = dest.join(fname);
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(&part);
    find_cli_in(&dest).ok_or_else(|| "zip extracted but no whisper-cli/main exe found".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn install_model_finalize(key: String, name: String) -> Result<(), String> {
    if !name.ends_with(".bin") || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad model name".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;
    rename_or_copy(&part, &models_dir().join(&name))
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

// deletes the GPU (cublas) engine directory; transcribe then falls back to
// the CPU engine on the next call
#[tauri::command]
pub async fn voice_remove_gpu() -> Result<(), String> {
    match std::fs::remove_dir_all(bin_gpu_dir()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// install Kokoro model — raw .onnx file (command name kept from the Piper
// era; frontend useVoiceInstall.ts still invokes install_piper_bin)
#[tauri::command]
pub async fn install_piper_bin(key: String) -> Result<(), String> {
    let part = part_path(&key)?;
    let meta = std::fs::metadata(&part).map_err(|e| format!("download incomplete: {e}"))?;
    if meta.len() > DOWNLOAD_CAP {
        let _ = std::fs::remove_file(&part);
        return Err("download too large (cap 2G)".into());
    }
    if meta.len() == 0 {
        return Err("empty download".into());
    }
    std::fs::create_dir_all(kokoro_dir()).map_err(|e| e.to_string())?;
    rename_or_copy(&part, &kokoro_model_path())?;
    clear_kokoro_cache();
    Ok(())
}

// Kokoro voices — per-voice `*.bin` in voices/ dir (single `voices.bin` legacy also handled)
#[tauri::command]
pub async fn install_tts_voice_part(key: String, name: String) -> Result<(), String> {
    if !name.ends_with(".bin") {
        return Err("bad voice file name".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad voice file name".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(kokoro_dir()).map_err(|e| e.to_string())?;
    let is_zip = {
        if let Ok(f) = std::fs::File::open(&part) {
            zip::ZipArchive::new(std::io::BufReader::new(f)).is_ok()
        } else { false }
    };
    let dest = if name == "voices.bin" {
        kokoro_voices_path()
    } else {
        std::fs::create_dir_all(kokoro_voices_dir()).map_err(|e| e.to_string())?;
        kokoro_voice_path(name.trim_end_matches(".bin"))
    };
    if is_zip {
        let file = std::fs::File::open(&part).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
            if f.is_dir() { continue; }
            let fname = f.name().rsplit(['/', '\\']).next().unwrap_or(f.name());
            if fname == name || fname == format!("{}.bin", name.trim_end_matches(".bin")) || fname == "voices.bin" {
                let mut w = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
                break;
            }
        }
        let _ = std::fs::remove_file(&part);
    } else {
        rename_or_copy(&part, &dest)?;
    }
    clear_kokoro_cache();
    Ok(())
}

// one downloaded CUDA pack zip (ort provider dlls, cudart, cuBLAS or cuDNN) —
// extracts every *.dll into kokoro/gpu-dlls; the pack is complete when all
// the dlls are present (tts_status.gpu)
#[tauri::command]
pub async fn install_kokoro_gpu_part(key: String) -> Result<(), String> {
    let part = part_path(&key)?;
    let file = std::fs::File::open(&part).map_err(|e| format!("download incomplete: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
    let dest = kokoro_gpu_dir();
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut extracted = 0;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().rsplit(['/', '\\']).next().unwrap_or(f.name()).to_string();
        if f.is_dir() || !name.ends_with(".dll") {
            continue;
        }
        let mut w = std::fs::File::create(dest.join(&name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
        extracted += 1;
    }
    let _ = std::fs::remove_file(&part);
    if extracted == 0 {
        return Err("no dlls found in pack zip".into());
    }
    Ok(())
}
