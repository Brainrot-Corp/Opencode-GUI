use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
    /// e.g. "12.0" for Blackwell sm_120, "8.9" for Ada — empty if unknown
    compute_cap: String,
}

#[tauri::command]
pub async fn voice_gpu() -> GpuStatus {
    let (nvidia, compute_cap) = tauri::async_runtime::spawn_blocking(|| -> (Option<String>, String) {
        let name = (|| {
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ]);
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
        })();
        let cap = if name.is_some() {
            let mut cmd = Command::new("nvidia-smi");
            cmd.args(["--query-gpu=compute_cap", "--format=csv,noheader,nounits"]);
            #[cfg(all(windows, not(debug_assertions)))]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            cmd.stdout(Stdio::piped()).stderr(Stdio::null());
            cmd.output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string())
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        (name, cap)
    })
    .await
    .ok()
    .unwrap_or((None, String::new()));
    match nvidia {
        Some(name) => GpuStatus { nvidia: true, name, compute_cap },
        None => GpuStatus { nvidia: false, name: String::new(), compute_cap: String::new() },
    }
}

// wipes the entire voice store — whisper engine + models, downloads, kokoro
// model + voices and legacy piper. Used by the settings "Clean state" reset
#[tauri::command]
pub async fn voice_remove_all() -> Result<(), String> {
    let _ = std::fs::remove_dir_all(whisper_dir());
    let _ = std::fs::remove_dir_all(kokoro_dir());
    let _ = std::fs::remove_dir_all(piper_dir());
    // whisper_dir removal already covers downloads, but ensure kokoro/piper are gone
    Ok(())
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

// ---------- Kokoro neural TTS (offline, GPU-accelerated, streaming) ----------
// Replaces Piper — same Tauri command names for frontend compat, but
// backed by Kokoro-82M via ONNX Runtime. Auto-selects CUDA → DirectML → CPU.
fn kokoro_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join(".opencode-gui")
        .join("kokoro")
}
fn kokoro_model_path() -> PathBuf {
    kokoro_dir().join("model.onnx")
}
fn kokoro_voices_dir() -> PathBuf {
    kokoro_dir().join("voices")
}
fn kokoro_voices_path() -> PathBuf {
    // legacy single-file path — kept for migration check
    kokoro_dir().join("voices.bin")
}
fn kokoro_voice_path(voice: &str) -> PathBuf {
    kokoro_voices_dir().join(format!("{}.bin", voice))
}
// optional CUDA pack — four zips (ort provider dlls + NVIDIA cudart/cuBLAS/cuDNN
// 13) extracted here; when complete, the CUDA EP loads them from this dir
fn kokoro_gpu_dir() -> PathBuf {
    kokoro_dir().join("gpu-dlls")
}
const KOKORO_GPU_DLLS: &[&str] = &[
    "onnxruntime_providers_shared.dll",
    "onnxruntime_providers_cuda.dll",
    "cudart64_13.dll",
    "cublas64_13.dll",
    "cublasLt64_13.dll",
    "cudnn64_9.dll",
];
fn kokoro_gpu_ready() -> bool {
    KOKORO_GPU_DLLS
        .iter()
        .all(|d| kokoro_gpu_dir().join(d).exists())
}
// debug log ring for TTS GPU fallback diagnostics — surfaced in the TTS menu
static TTS_DEBUG_LOG: std::sync::OnceLock<Mutex<Vec<String>>> = std::sync::OnceLock::new();
fn tts_debug_store() -> &'static Mutex<Vec<String>> {
    TTS_DEBUG_LOG.get_or_init(|| Mutex::new(Vec::new()))
}
fn push_tts_log(msg: String) {
    let line = format!("[{}] {}", chrono_like_now(), msg);
    eprintln!("{line}");
    if let Ok(mut g) = tts_debug_store().lock() {
        g.push(line);
        if g.len() > 40 {
            g.remove(0);
        }
    }
}
fn chrono_like_now() -> String {
    // HH:MM:SS without extra crates
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() % 86400)
        .unwrap_or(0);
    format!("{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
}

// ORT loads its CUDA provider from the exe dir / legacy search, which ignores
// AddDllDirectory — SetDllDirectory slots the pack dir into the legacy order
// (exe dir → system32 → this dir → PATH) so the provider and its cublas/cudnn
// deps all resolve from the pack
fn enable_kokoro_gpu_search() {
    static DONE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if kokoro_gpu_ready() {
        DONE.get_or_init(|| {
            #[cfg(windows)]
            unsafe {
                use windows::core::HSTRING;
                use windows::Win32::System::LibraryLoader::SetDllDirectoryW;
                let dir = kokoro_gpu_dir();
                let ok = SetDllDirectoryW(&HSTRING::from(dir.as_os_str())).is_ok();
                if ok {
                    push_tts_log(format!("GPU pack: SetDllDirectoryW({}) ok", dir.display()));
                } else {
                    push_tts_log(format!("GPU pack: SetDllDirectoryW({}) FAILED", dir.display()));
                }
            }
            #[cfg(not(windows))]
            push_tts_log("GPU pack: found, enabled".to_string());
        });
    } else {
        // log once per status check if pack is incomplete
        let missing: Vec<_> = KOKORO_GPU_DLLS
            .iter()
            .filter(|d| !kokoro_gpu_dir().join(d).exists())
            .copied()
            .collect();
        if !missing.is_empty() && kokoro_gpu_dir().exists() {
            push_tts_log(format!("GPU pack incomplete, missing: {}", missing.join(", ")));
        }
    }
}
// legacy piper paths — kept for migration/cleanup, not used for new installs
fn piper_dir() -> PathBuf {
    whisper_dir().join("piper")
}

// Kokoro voices — curated subset from hexgrad/Kokoro-82M covering 9 languages.
// Voice IDs are the file-stem names in voices.bin (e.g. "af_heart").
const KOKORO_VOICES: &[&str] = &[
    "af_heart", "af_bella", "af_sarah", "af_nicole", "af_sky",
    "am_adam", "am_michael",
    "bf_emma", "bf_isabella", "bm_george", "bm_lewis",
    "ef_dora", "em_alex",
    "ff_siwis",
    "if_sara", "im_nicola",
    "jf_alpha", "jf_gongitsune", "jf_nezumi", "jm_kumo",
    "pf_dora", "pm_alex",
    "zf_xiaobei", "zf_xiaoni", "zm_yunxi", "zm_yunyang",
];
#[allow(dead_code)]
fn kokoro_voice_label(id: &str) -> String {
    let lang = match id.split('_').next().unwrap_or("") {
        "af" | "am" => "US English",
        "bf" | "bm" => "British English",
        "ef" | "em" => "Spanish",
        "ff" => "French",
        "if" | "im" => "Italian",
        "jf" | "jm" => "Japanese",
        "pf" | "pm" => "Portuguese",
        "zf" | "zm" => "Chinese",
        "hf" | "hm" => "Hindi",
        _ => "Unknown",
    };
    let name = id.split('_').nth(1).unwrap_or(id);
    format!("{name} · {lang}")
}
fn map_piper_to_kokoro(voice: &str) -> String {
    // Piper → Kokoro migration: map old Piper voice IDs to closest Kokoro.
    // Piper voices were like "en_US-amy-medium" or "fr_FR-siwis-medium" with .onnx suffix.
    let v = voice.trim().trim_end_matches(".onnx").to_lowercase();
    if v.contains("siwis") || v.contains("ff_") { return "ff_siwis".into(); }
    if v.contains("thorsten") || v.contains("de_") { return "af_heart".into(); }
    if v.contains("sharvard") || v.contains("es_") { return "ef_dora".into(); }
    if v.contains("huayan") || v.contains("zh_") { return "zf_xiaobei".into(); }
    if v.contains("amy") || v.contains("heart") { return "af_heart".into(); }
    if v.contains("lessac") || v.contains("bella") { return "af_bella".into(); }
    if v.contains("ryan") || v.contains("adam") { return "am_adam".into(); }
    if v.contains("alba") || v.contains("emma") { return "bf_emma".into(); }
    if v.contains("southern") || v.contains("isabella") { return "bf_isabella".into(); }
    if v.contains("faber") || v.contains("dora") { return "pf_dora".into(); }
    // Already a Kokoro ID?
    if KOKORO_VOICES.contains(&v.as_str()) { return v; }
    if KOKORO_VOICES.contains(&voice) { return voice.to_string(); }
    // Fallback to default heart voice
    "af_heart".into()
}
fn is_kokoro_voice(name: &str) -> bool {
    let n = name.trim().trim_end_matches(".onnx");
    KOKORO_VOICES.contains(&n) || KOKORO_VOICES.contains(&name)
}

// model_q8f16.onnx (86,033,585 bytes) hard-crashes onnxruntime with
// STATUS_ACCESS_VIOLATION (0xC0000005) during session load — kills the whole
// process, unrecoverable at any provider setting. The int8 model_quantized.onnx
// (92,361,116 bytes) works on every provider path, so treat the broken download
// as not installed and re-download.
const BROKEN_Q8F16_MODEL_LEN: u64 = 86_033_585;
fn kokoro_model_broken() -> bool {
    std::fs::metadata(kokoro_model_path())
        .map(|m| m.len() == BROKEN_Q8F16_MODEL_LEN)
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct TtsStatus {
    bin: bool,
    gpu: bool,
    voices: Vec<String>,
    gpu_log: String,
}

fn tts_last_log() -> String {
    tts_debug_store()
        .lock()
        .ok()
        .and_then(|g| g.last().cloned())
        .unwrap_or_default()
}

#[tauri::command]
pub fn tts_status() -> TtsStatus {
    // ensure GPU search is primed so logs reflect current pack state
    enable_kokoro_gpu_search();
    let has_model = kokoro_model_path().exists() && !kokoro_model_broken();
    if !has_model {
        return TtsStatus { bin: false, gpu: kokoro_gpu_ready(), voices: Vec::new(), gpu_log: tts_last_log() };
    }
    let mut voices = Vec::new();
    if let Ok(rd) = std::fs::read_dir(kokoro_voices_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".bin") {
                if KOKORO_VOICES.contains(&id) {
                    voices.push(id.to_string());
                }
            }
        }
    }
    if voices.is_empty() && kokoro_voices_path().exists() {
        // legacy single-file voices.bin contains all voices
        voices = KOKORO_VOICES.iter().map(|s| s.to_string()).collect();
    }
    voices.sort();
    TtsStatus { bin: true, gpu: kokoro_gpu_ready(), voices, gpu_log: tts_last_log() }
}

#[tauri::command]
pub fn tts_debug_log() -> Vec<String> {
    tts_debug_store()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn tts_clear_debug() -> Result<(), String> {
    if let Ok(mut g) = tts_debug_store().lock() {
        g.clear();
    }
    Ok(())
}

// Kokoro TTS instance — lazily initialized, GPU auto-selected (CUDA → DirectML → CPU).
// Uses tokio::sync::OnceCell because KokoroTts::new is async.
static KOKORO: std::sync::OnceLock<tokio::sync::Mutex<Option<Arc<kokoro_en::KokoroTts>>>> = std::sync::OnceLock::new();
fn kokoro_lock() -> &'static tokio::sync::Mutex<Option<Arc<kokoro_en::KokoroTts>>> {
    KOKORO.get_or_init(|| tokio::sync::Mutex::new(None))
}
async fn get_kokoro() -> Result<Arc<kokoro_en::KokoroTts>, String> {
    let mut guard = kokoro_lock().lock().await;
    if let Some(tts) = guard.clone() {
        return Ok(tts);
    }
    let model = kokoro_model_path();
    if !model.exists() {
        return Err("kokoro model not installed — set it up in Settings > Voice".into());
    }
    if kokoro_model_broken() {
        return Err("kokoro model is a broken q8f16 build — reinstall it in Settings > Voice".into());
    }
    // GPU pack installed → make its DLLs resolvable before the session build
    enable_kokoro_gpu_search();
    // voices may be per-voice dir or legacy single file
    let voices_path = if kokoro_voices_dir().exists() {
        let has_any = std::fs::read_dir(kokoro_voices_dir()).map(|mut rd| rd.next().is_some()).unwrap_or(false);
        if has_any {
            kokoro_voices_dir()
        } else if kokoro_voices_path().exists() {
            kokoro_voices_path()
        } else {
            return Err("kokoro voices not installed — set it up in Settings > Voice".into());
        }
    } else if kokoro_voices_path().exists() {
        kokoro_voices_path()
    } else {
        return Err("kokoro voices not installed — set it up in Settings > Voice".into());
    };
    // GPU auto-select: when gpu_pack is present and provider=auto, try CUDA
    // explicitly first so the fallback is visible in the TTS debug log. The
    // crate's internal auto also falls back (e.g. Blackwell sm_120
    // NoKernelImageForDevice → rebuild on CPU) but that fallback is silent
    // from the caller's PoV (still Ok) — explicit try makes it explicit.
    let provider = std::env::var("KOKORO_ORT_PROVIDER").unwrap_or_else(|_| "auto".into());
    let gpu_ready = kokoro_gpu_ready();
    push_tts_log(format!(
        "Kokoro init: provider={}, gpu_pack={}, model={}, voices={}",
        provider, gpu_ready, model.display(), voices_path.display()
    ));
    // explicit CUDA probe when pack is present and user left provider on auto
    if provider.eq_ignore_ascii_case("auto") && gpu_ready {
        let prev = std::env::var("KOKORO_ORT_PROVIDER").ok();
        std::env::set_var("KOKORO_ORT_PROVIDER", "cuda");
        let cuda_res = kokoro_en::KokoroTts::new(&model, &voices_path).await;
        if let Some(v) = prev.clone() { std::env::set_var("KOKORO_ORT_PROVIDER", v); } else { std::env::remove_var("KOKORO_ORT_PROVIDER"); }
        match cuda_res {
            Ok(t) => {
                push_tts_log("Kokoro init ok (cuda) — GPU active".to_string());
                let arc = Arc::new(t);
                *guard = Some(arc.clone());
                return Ok(arc);
            }
            Err(e) => {
                let msg = e.to_string();
                push_tts_log(format!("Kokoro CUDA init failed ({}), falling back to CPU", msg));
                eprintln!("kokoro CUDA init failed ({}), falling back to CPU", msg);
                // fall through to CPU retry below
            }
        }
    }
    let tts = match kokoro_en::KokoroTts::new(&model, &voices_path).await {
        Ok(t) => {
            let hint = if provider.eq_ignore_ascii_case("cpu") {
                "cpu-forced"
            } else if gpu_ready {
                "auto (explicit CUDA already tried) — CPU fallback active"
            } else {
                "auto, gpu_pack=false — CPU"
            };
            push_tts_log(format!("Kokoro init ok ({})", hint));
            t
        },
        Err(e) => {
            let msg = e.to_string();
            // If auto/CUDA/DML failed, retry once with CPU forced (covers the
            // DML 80070057 case and missing CUDA toolkit)
            if msg.contains("80070057") || msg.contains("Dml") || msg.contains("DirectML") || msg.contains("CUDA") {
                let line = format!("kokoro init with {} failed ({}), retrying with CPU", provider, msg);
                push_tts_log(line.clone());
                eprintln!("{line}");
                let prev2 = std::env::var("KOKORO_ORT_PROVIDER").ok();
                std::env::set_var("KOKORO_ORT_PROVIDER", "cpu");
                let res = kokoro_en::KokoroTts::new(&model, &voices_path).await;
                if let Some(v) = prev2 { std::env::set_var("KOKORO_ORT_PROVIDER", v); } else { std::env::remove_var("KOKORO_ORT_PROVIDER"); }
                match res {
                    Ok(t) => {
                        push_tts_log("Kokoro init ok after CPU fallback — GPU was unavailable/faulty, now on CPU".to_string());
                        t
                    }
                    Err(e2) => {
                        let line2 = format!("kokoro init failed (cpu fallback also failed): {e} | {e2}");
                        push_tts_log(line2.clone());
                        return Err(line2);
                    }
                }
            } else {
                let line = format!("kokoro init failed: {msg}");
                push_tts_log(line.clone());
                return Err(line);
            }
        }
    };
    let arc = Arc::new(tts);
    *guard = Some(arc.clone());
    Ok(arc)
}
fn clear_kokoro_cache() {
    if let Some(m) = KOKORO.get() {
        // best-effort: clear cached instance so next tts_speak re-loads new model
        if let Ok(mut g) = m.try_lock() {
            *g = None;
        }
    }
}
fn f32_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    let len = samples.len() as u32;
    // RIFF header
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len * 2).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(len * 2).to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

// install Kokoro model — raw .onnx file
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
    std::fs::rename(&part, kokoro_model_path()).or_else(|_| -> Result<(), String> {
        std::fs::copy(&part, kokoro_model_path()).map(|_| ()).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&part);
        Ok(())
    })?;
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
        std::fs::rename(&part, &dest).or_else(|_| -> Result<(), String> {
            std::fs::copy(&part, &dest).map(|_| ()).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&part);
            Ok(())
        })?;
    }
    clear_kokoro_cache();
    Ok(())
}

// removes the entire Kokoro engine (model + all voices) — used by the
// Options tab's engine row
#[tauri::command]
pub async fn kokoro_remove_engine() -> Result<(), String> {
    let _ = std::fs::remove_file(kokoro_model_path());
    let _ = std::fs::remove_dir_all(kokoro_voices_dir());
    let _ = std::fs::remove_file(kokoro_voices_path());
    clear_kokoro_cache();
    Ok(())
}

// one downloaded CUDA pack zip (ort provider dlls, cudart, cuBLAS or cuDNN) —
// extracts every *.dll into kokoro/gpu-dlls; the pack is complete when all
// KOKORO_GPU_DLLS are present (tts_status.gpu)
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

// deletes the optional CUDA pack — the next synth falls back to CPU/DML
#[tauri::command]
pub async fn tts_gpu_remove() -> Result<(), String> {
    match std::fs::remove_dir_all(kokoro_gpu_dir()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Kokoro per-voice .bin files in voices/
#[tauri::command]
pub fn tts_remove_voice(name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad voice name".into());
    }
    let id = name.trim_end_matches(".bin");
    if is_kokoro_voice(id) || name == "voices.bin" || is_kokoro_voice(&name) {
        let path = if name == "voices.bin" {
            kokoro_voices_path()
        } else {
            kokoro_voice_path(id)
        };
        // try per-voice file, then legacy single file
        match std::fs::remove_file(&path) {
            Ok(()) => { clear_kokoro_cache(); return Ok(()); }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // also try single file for single-voice installs
                if path != kokoro_voices_path() {
                    if let Ok(()) = std::fs::remove_file(kokoro_voices_path()) {
                        clear_kokoro_cache(); return Ok(());
                    }
                }
                return Ok(());
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("bad voice name".into())
}

// synthesizes text with Kokoro (GPU → DirectML → CPU auto), returns WAV bytes.
#[tauri::command]
pub async fn tts_speak(text: String, voice: String, speed: Option<f64>) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() || text.len() > 20_000 {
        return Err("bad speak text".into());
    }
    if !kokoro_model_path().exists() {
        return Err(format!("kokoro not installed — set it up in Settings > Voice (missing {})", kokoro_model_path().display()));
    }
    let kvoice = map_piper_to_kokoro(&voice);
    // voices may be per-voice dir (voices/af_heart.bin) or legacy single file (voices.bin)
    let has_voice = kokoro_voice_path(&kvoice).exists() || kokoro_voices_path().exists() || kokoro_voices_dir().exists() && std::fs::read_dir(kokoro_voices_dir()).map(|mut rd| rd.next().is_some()).unwrap_or(false);
    if !has_voice {
        return Err(format!("kokoro voice {} not installed — download it in Settings > Voice › Voices (missing {})", kvoice, kokoro_voice_path(&kvoice).display()));
    }
    let sp = speed.unwrap_or(1.0).clamp(0.5, 2.0) as f32;
    let gpu_active = kokoro_gpu_ready();
    let tts = get_kokoro().await?;
    let v = kokoro_en::Voice::new(kvoice.clone()).with_speed(sp);
    // offload blocking ONNX inference to blocking pool
    let txt_len = text.len();
    let wav = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let start = Instant::now();
        let rt = tokio::runtime::Handle::try_current();
        let fut = async {
            let (samples, _) = tts.synth(text.clone(), v).await.map_err(|e| e.to_string())?;
            Ok::<Vec<f32>, String>(samples)
        };
        let samples = if let Ok(h) = rt {
            h.block_on(fut)?
        } else {
            tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?.block_on(fut)?
        };
        let elapsed = start.elapsed();
        let ms = elapsed.as_millis();
        let secs = samples.len() as f32 / 24000.0;
        push_tts_log(format!(
            "synth ok: {} chars → {:.1}s audio in {}ms ({:.1}x realtime, {})",
            txt_len,
            secs,
            ms,
            if secs > 0.0 { secs * 1000.0 / ms as f32 } else { 0.0 },
            if gpu_active { "gpu-pack present" } else { "cpu" }
        ));
        Ok::<Vec<u8>, String>(f32_to_wav(&samples, 24000))
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))??;
    Ok(wav)
}

// streaming TTS — emits WAV chunks via Channel as each sentence is synthesized.
// Frontend creates a Channel<Vec<u8>> and plays chunks as they arrive.
#[tauri::command]
pub async fn tts_stream(
    text: String,
    voice: String,
    speed: Option<f64>,
    on_chunk: tauri::ipc::Channel<Vec<u8>>,
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 20_000 {
        return Err("bad speak text".into());
    }
    if !kokoro_model_path().exists() {
        return Err(format!("kokoro not installed — set it up in Settings > Voice (missing {})", kokoro_model_path().display()));
    }
    let kvoice_chk = map_piper_to_kokoro(&voice);
    let has_voice_chk = kokoro_voice_path(&kvoice_chk).exists() || kokoro_voices_path().exists() || kokoro_voices_dir().exists() && std::fs::read_dir(kokoro_voices_dir()).map(|mut rd| rd.next().is_some()).unwrap_or(false);
    if !has_voice_chk {
        // fallback to non-streaming for one chunk (will surface the same voice error)
        let wav = tts_speak(text, voice, speed).await?;
        let _ = on_chunk.send(wav);
        return Ok(());
    }
    let kvoice = map_piper_to_kokoro(&voice);
    let sp = speed.unwrap_or(1.0).clamp(0.5, 2.0) as f32;
    let tts = get_kokoro().await?;
    // Split into sentences for low-latency streaming — Kokoro's own splitter
    // is used when available, else simple regex.
    let sentences: Vec<String> = {
        // try kokoro's splitter first (handles abbreviations, etc.)
        // fallback to simple split
        let raw = text.clone();
        let parts: Vec<String> = raw
            .split(|c| c == '.' || c == '!' || c == '?' || c == '\n')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if parts.is_empty() { vec![text.clone()] } else {
            // re-add sentence terminators for natural prosody
            let mut out = Vec::new();
            let mut rest = text.as_str();
            for p in &parts {
                if let Some(idx) = rest.find(p.as_str()) {
                    let end = idx + p.len();
                    let mut sent = rest[idx..end].to_string();
                    // capture following punctuation
                    let after = &rest[end..];
                    if let Some(c) = after.chars().next() {
                        if matches!(c, '.' | '!' | '?' ) { sent.push(c); }
                    }
                    out.push(sent);
                    rest = &rest[end..];
                } else {
                    out.push(p.clone());
                }
            }
            if out.is_empty() { vec![text.clone()] } else { out }
        }
    };
    for sent in sentences {
        let s = sent.trim().to_string();
        if s.is_empty() { continue; }
        let v = kokoro_en::Voice::new(kvoice.clone()).with_speed(sp);
        let tts_clone = tts.clone();
        let (samples, _) = tts_clone.synth(s, v).await.map_err(|e| e.to_string())?;
        let wav = f32_to_wav(&samples, 24000);
        let _ = on_chunk.send(wav);
    }
    Ok(())
}
