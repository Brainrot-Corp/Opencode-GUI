use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

// download size cap for voice engine/model fetches — enforced by curl
// --max-filesize and re-checked after download
const DOWNLOAD_CAP: u64 = 2 * 1024 * 1024 * 1024;

fn unique_temp_path(prefix: &str, ext: &str) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tid = format!("{:?}", std::thread::current().id());
    let mut hasher = DefaultHasher::new();
    ts.hash(&mut hasher);
    seq.hash(&mut hasher);
    pid.hash(&mut hasher);
    tid.hash(&mut hasher);
    let rnd = hasher.finish() & 0xffff;
    std::env::temp_dir().join(format!("{prefix}-{pid}-{ts}-{seq:04}-{rnd:04x}.{ext}"))
}

// everything lives under ~/.config/.opencode-gui/whisper/ Ã¢â‚¬â€ same root as themes.json
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

// separate GPU engine dir (cublas build) so CPU/GPU installs can coexist —
// transcribe picks per call and falls back to the CPU one on failure
fn bin_gpu_dir() -> PathBuf {
    whisper_dir().join("bin-gpu")
}

fn models_dir() -> PathBuf {
    whisper_dir().join("models")
}

fn downloads_dir() -> PathBuf {
    whisper_dir().join("downloads")
}

fn find_cli_in(dir: &Path) -> Option<PathBuf> {
    for name in ["whisper-cli.exe", "main.exe"] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn find_cli() -> Option<PathBuf> {
    find_cli_in(&bin_dir())
}

fn find_gpu_cli() -> Option<PathBuf> {
    find_cli_in(&bin_gpu_dir())
}

#[derive(serde::Serialize)]
pub struct VoiceStatus {
    bin: bool,
    gpu_bin: bool,
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
        gpu_bin: find_gpu_cli().is_some(),
        models,
    }
}

// NVIDIA GPU detection for the cublas whisper build — NVIDIA is the only
// vendor with a prebuilt GPU engine (no modern release ships a Vulkan
// build). Enumerates Win32_VideoController through the OS CIM cmdlet,
// zero extra deps.
#[derive(serde::Serialize)]
pub struct GpuStatus {
    nvidia: bool,
    name: String,
}

#[tauri::command]
pub async fn voice_gpu() -> GpuStatus {
    let nvidia = tauri::async_runtime::spawn_blocking(|| -> Option<String> {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
        ]);
        // release: no console flash next to the frameless window
        #[cfg(all(windows, not(debug_assertions)))]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .find(|l| l.to_lowercase().contains("nvidia"))
            .map(str::to_string)
    })
    .await
    .ok()
    .flatten();
    match nvidia {
        Some(name) => GpuStatus { nvidia: true, name },
        None => GpuStatus {
            nvidia: false,
            name: String::new(),
        },
    }
}

// wipes the entire voice store — whisper engine + models, downloads, piper
// engine + voices. Used by the settings "Clean state" reset
#[tauri::command]
pub async fn voice_remove_all() -> Result<(), String> {
    std::fs::remove_dir_all(whisper_dir()).map_err(|e| e.to_string())
}

// downloads url to <downloads>/<key>.part using the OS curl.exe — the
// webview's fetch() can't follow GitHub/HF release redirects cross-origin
// async so curl runs off the main thread Ã¢â‚¬â€ sync commands freeze the UI
#[tauri::command]
pub async fn voice_download(key: String, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("bad download url".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(downloads_dir()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("curl.exe");
    cmd.args([
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "1800",
        "--max-filesize",
    ]);
    cmd.arg(DOWNLOAD_CAP.to_string());
    cmd.arg("-o").arg(&part).arg(&url);
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
    std::fs::rename(&part, models_dir().join(&name)).or_else(|_| {
        // rename across volumes fails Ã¢â‚¬â€ fall back to copy
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

// runs whisper-cli over a 16 kHz mono s16 WAV produced by the webview;
// returns the plain-text transcription (-nt strips timestamps). With
// translate=true, whisper decodes any detected language straight into
// English (used as the voice router's multilingual fallback pass).
// gpu=true prefers the cublas engine in bin-gpu/ (NVIDIA); the result names
// the engine that actually did the work ("gpu" | "cpu") and why it fell
// back, since a cuda-less cublas build still succeeds while computing on cpu
#[tauri::command]
pub async fn voice_transcribe(
    audio: Vec<u8>,
    model: String,
    translate: Option<bool>,
    gpu: Option<bool>,
) -> Result<TranscribeOut, String> {
    if !model.ends_with(".bin") || model.contains("..") {
        return Err("bad model name".into());
    }
    let mp = models_dir().join(model);
    if !mp.exists() {
        return Err(format!("model {} is not downloaded", mp.display()));
    }

    let tmp = unique_temp_path("oc-voice", "wav");
    // EH-11: create_new + unique suffix avoids same-ms collision
    {
        use std::fs::OpenOptions;
        use std::io::Write;
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .or_else(|_| std::fs::File::create(&tmp))
            .map_err(|e| e.to_string())?;
        f.write_all(&audio).map_err(|e| e.to_string())?;
    }

    let tr = translate.unwrap_or(false);
    let gpu_cli = find_gpu_cli();
    let cpu_cli = find_cli();
    // GPU requested but no GPU engine installed → use the CPU one; a GPU
    // engine that spawns but fails at runtime falls back below
    let primary = if gpu.unwrap_or(false) {
        gpu_cli.clone().or_else(|| cpu_cli.clone())
    } else {
        cpu_cli.clone()
    }
    .ok_or_else(|| "voice engine not installed — set it up in Settings > Voice".to_string())?;
    let want_gpu = Some(&primary) == gpu_cli.as_ref();
    let cpu_fallback = if want_gpu { cpu_cli.clone() } else { None };

    // EH-10+TF-02: offload blocking wait to dedicated pool; single wait without double-reap
    let tmp2 = tmp.clone();
    let blocking = tauri::async_runtime::spawn_blocking(move || -> Result<TranscribeOut, String> {
        let mut engine = if want_gpu { "gpu" } else { "cpu" };
        let mut note = String::new();
        let (text, stderr) = match run_whisper(&primary, &mp, &tmp2, tr) {
            Ok(v) => v,
            Err(e) => match cpu_fallback {
                // engine crashed (old driver, missing CUDA dlls) → retry on CPU
                Some(cpu) => {
                    engine = "cpu";
                    note = format!("engine failed: {e}");
                    run_whisper(&cpu, &mp, &tmp2, tr)?
                }
                None => return Err(e),
            },
        };
        if engine == "gpu" {
            // a cublas build that can't reach CUDA still exits 0 while quietly
            // computing on the cpu — verify from its own log that cuda engaged
            // (device enumeration / backend registry) and didn't report an
            // init failure; on mismatch surface whisper's own last lines
            let low = stderr.to_ascii_lowercase();
            let cuda_failed = low.contains("failed to initialize cuda") || low.contains("cuda_init: failed");
            if !low.contains("cuda") || cuda_failed {
                engine = "cpu";
                let tail = stderr
                    .lines()
                    .rev()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" | ");
                let tail: String = tail.chars().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect();
                note = format!("gpu build ran without cuda: {tail}");
            }
        }
        Ok(TranscribeOut {
            text,
            engine: engine.into(),
            note,
        })
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))?;

    let _ = std::fs::remove_file(&tmp);
    blocking
}

// what voice_transcribe hands back — text plus which engine actually did the
// work ("gpu" | "cpu") and why it fell back, so the UI can show the truth
#[derive(serde::Serialize)]
pub struct TranscribeOut {
    text: String,
    engine: String,
    note: String,
}

// one whisper-cli invocation over the temp wav — blocking, only call from
// spawn_blocking. Hard cap so a wedged process can't pin the UI mic state.
// Returns (transcription, stderr log) — stderr carries the backend/device
// lines used to verify the gpu build engaged cuda.
fn run_whisper(cli: &Path, mp: &Path, tmp: &Path, translate: bool) -> Result<(String, String), String> {
    use std::io::Read;
    let mut cmd = Command::new(cli);
    cmd.arg("-m").arg(mp).arg("-f").arg(tmp);
    cmd.args(["-nt", "-np"]);
    if translate {
        // source language is auto-detected; the decode task becomes translate
        cmd.arg("--translate");
    }
    // release: CREATE_NO_WINDOW keeps a console from flashing next to the GUI
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to run whisper-cli: {e}"))?;
    // drain both pipes on threads so a chatty child can't deadlock on a full
    // pipe while the poll loop waits (TF-02: child reaped via try_wait only)
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = Instant::now() + Duration::from_secs(180);
    let status;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => {
                status = s;
                break;
            }
            None => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_t.join();
                    let _ = err_t.join();
                    return Err("transcription timed out".into());
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    }
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    if !status.success() && stdout.is_empty() {
        let tail = String::from_utf8_lossy(&stderr)
            .lines()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!("whisper-cli failed ({}): {}", status, tail));
    }
    let text = String::from_utf8_lossy(&stdout);
    let clean = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    Ok((clean, String::from_utf8_lossy(&stderr).to_string()))
}

// ---------- piper neural TTS (offline, better than system voices) ----------
fn piper_dir() -> PathBuf {
    whisper_dir().join("piper")
}

fn piper_exe() -> PathBuf {
    piper_dir().join("piper.exe")
}

fn tts_voices_dir() -> PathBuf {
    piper_dir().join("voices")
}

#[derive(serde::Serialize)]
pub struct TtsStatus {
    bin: bool,
    voices: Vec<String>,
}

#[tauri::command]
pub fn tts_status() -> TtsStatus {
    let mut voices = Vec::new();
    if let Ok(rd) = std::fs::read_dir(tts_voices_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // frontend treats voices as bare ids ("<id>", no extension) —
            // strip here so delete/preview/labels all address the same file
            if let Some(id) = name.strip_suffix(".onnx") {
                voices.push(id.to_string());
            }
        }
    }
    voices.sort();
    TtsStatus {
        bin: piper_exe().exists(),
        voices,
    }
}

// unzip preserving directory layout - piper ships espeak-ng-data/ + dlls
// next to the exe, so the whisper-style flatten would break it
#[tauri::command]
pub async fn install_piper_bin(key: String) -> Result<(), String> {
    let part = part_path(&key)?;
    // EH-12: cap + stream instead of read whole file
    let meta = std::fs::metadata(&part).map_err(|e| format!("download incomplete: {e}"))?;
    if meta.len() > DOWNLOAD_CAP {
        let _ = std::fs::remove_file(&part);
        return Err("download too large (cap 2G)".into());
    }
    if meta.len() == 0 {
        return Err("empty download".into());
    }
    let file = std::fs::File::open(&part).map_err(|e| format!("download incomplete: {e}"))?;
    let reader = std::io::BufReader::new(file);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    let dest = piper_dir();
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().replace('\\', "/");
        if name.contains("..") || name.starts_with('/') {
            continue; // zip-slip guard
        }
        let out = dest.join(&name);
        if f.is_dir() {
            let _ = std::fs::create_dir_all(&out);
            continue;
        }
        if let Some(p) = out.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
    }
    // some releases wrap everything in a folder - hoist one level if needed
    if !dest.join("piper.exe").exists() {
        let inner = std::fs::read_dir(&dest)
            .ok()
            .and_then(|rd| rd.flatten().find(|e| e.path().join("piper.exe").exists()));
        if let Some(inner) = inner {
            for e in std::fs::read_dir(inner.path())
                .map_err(|e| e.to_string())?
                .flatten()
            {
                let _ = std::fs::rename(e.path(), dest.join(e.file_name()));
            }
        }
    }
    if !dest.join("piper.exe").exists() {
        return Err("zip extracted but piper.exe not found".into());
    }
    let _ = std::fs::remove_file(&part);
    Ok(())
}

// moves a downloaded .part into the voice store as <name>
// (.onnx model or its .onnx.json sidecar)
#[tauri::command]
pub async fn install_tts_voice_part(key: String, name: String) -> Result<(), String> {
    let ok = name.ends_with(".onnx") || name.ends_with(".onnx.json");
    if !ok || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad voice file name".into());
    }
    let part = part_path(&key)?;
    std::fs::create_dir_all(tts_voices_dir()).map_err(|e| e.to_string())?;
    std::fs::rename(&part, tts_voices_dir().join(&name)).or_else(|_| {
        // rename across volumes fails - fall back to copy
        std::fs::copy(&part, tts_voices_dir().join(&name))
            .map(|_| ())
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&part);
        Ok(())
    })
}

// removes a voice and its .json sidecar
#[tauri::command]
pub fn tts_remove_voice(name: String) -> Result<(), String> {
    if !name.ends_with(".onnx")
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err("bad voice name".into());
    }
    let dir = tts_voices_dir();
    match std::fs::remove_file(dir.join(&name)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let _ = std::fs::remove_file(dir.join(format!("{name}.json")));
    Ok(())
}

// synthesizes text with piper, returns WAV bytes for the webview to play
#[tauri::command]
pub async fn tts_speak(text: String, voice: String, speed: Option<f64>) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() || text.len() > 20_000 {
        return Err("bad speak text".into());
    }
    if !voice.ends_with(".onnx")
        || voice.contains('/')
        || voice.contains('\\')
        || voice.contains("..")
    {
        return Err("bad voice name".into());
    }
    let exe = piper_exe();
    if !exe.exists() {
        return Err("piper is not installed - set it up in Settings > Voice".into());
    }
    let model = tts_voices_dir().join(&voice);
    if !model.exists() {
        return Err(format!("voice {voice} is not downloaded"));
    }

    let wav = unique_temp_path("oc-tts", "wav");

    // EH-10: offload blocking poll loop to dedicated blocking pool
    let blocking = {
        let wav_clone = wav.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let mut cmd = Command::new(&exe);
            cmd.arg("-m").arg(&model).arg("-f").arg(&wav_clone);
            // piper's length-scale is inverse speed; clamp to sane bounds
            let sp = speed.unwrap_or(1.0).clamp(0.5, 2.0);
            if (sp - 1.0).abs() > f64::EPSILON {
                cmd.arg("--length-scale").arg(format!("{}", 1.0 / sp));
            }
            // piper logs to stderr; nothing reads it here, so send it to null
            // rather than risk a full pipe blocking the child
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(all(windows, not(debug_assertions)))]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = cmd.spawn().map_err(|e| format!("failed to run piper: {e}"))?;
            // feed the text, then close stdin so piper starts synthesis
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write as _;
                let _ = stdin.write_all(text.as_bytes());
            }
            // hard cap so a wedged process can't hang the UI forever
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                match child.try_wait().map_err(|e| e.to_string())? {
                    Some(_) => break,
                    None => {
                        if Instant::now() > deadline {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err("speech synthesis timed out".into());
                        }
                        std::thread::sleep(Duration::from_millis(40));
                    }
                }
            }
            std::fs::read(&wav_clone).map_err(|e| format!("synthesis failed: {e}"))
        })
        .await
        .map_err(|e| format!("task join failed: {e}"))?
    };

    let _ = std::fs::remove_file(&wav);
    blocking
}
