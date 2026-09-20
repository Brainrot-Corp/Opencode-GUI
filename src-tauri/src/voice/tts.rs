// Text-to-speech: Kokoro-82M via ONNX Runtime (CUDA → DirectML → CPU
// auto-select), WAV + raw-PCM synth paths, debug ring, engine/voice removal.
// Replaces Piper — same Tauri command names for frontend compat.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub(crate) fn kokoro_dir() -> PathBuf {
    crate::platform::home_dir()
        .join(".config")
        .join(".opencode-gui")
        .join("kokoro")
}
pub(crate) fn kokoro_model_path() -> PathBuf {
    kokoro_dir().join("model.onnx")
}
pub(crate) fn kokoro_voices_dir() -> PathBuf {
    kokoro_dir().join("voices")
}
pub(crate) fn kokoro_voices_path() -> PathBuf {
    // legacy single-file path — kept for migration check
    kokoro_dir().join("voices.bin")
}
pub(crate) fn kokoro_voice_path(voice: &str) -> PathBuf {
    kokoro_voices_dir().join(format!("{}.bin", voice))
}
// optional CUDA pack — four zips (ort provider dlls + NVIDIA cudart/cuBLAS/cuDNN
// 13) extracted here; when complete, the CUDA EP loads them from this dir
pub(crate) fn kokoro_gpu_dir() -> PathBuf {
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
pub(crate) fn kokoro_gpu_ready() -> bool {
    KOKORO_GPU_DLLS
        .iter()
        .all(|d| kokoro_gpu_dir().join(d).exists())
}
// debug log ring for TTS GPU fallback diagnostics — surfaced in the TTS menu
static TTS_DEBUG_LOG: std::sync::OnceLock<Mutex<Vec<String>>> = std::sync::OnceLock::new();
pub(crate) fn tts_debug_store() -> &'static Mutex<Vec<String>> {
    TTS_DEBUG_LOG.get_or_init(|| Mutex::new(Vec::new()))
}
pub(crate) fn push_tts_log(msg: String) {
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
// ponytail: legacy Piper→Kokoro migration shim — kept because frontend
// settings may still carry pre-migration `oc.settings.ttsVoice` Piper ids;
// delete once a release cycle has passed with no Piper-era settings around.
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

// a voice is installed if its per-voice file exists, the legacy single-file
// voices.bin exists, or the voices dir is non-empty (shared by tts_speak and
// tts_speak_pcm)
fn kokoro_voice_installed(id: &str) -> bool {
    kokoro_voice_path(id).exists()
        || kokoro_voices_path().exists()
        || kokoro_voices_dir().exists()
            && std::fs::read_dir(kokoro_voices_dir()).map(|mut rd| rd.next().is_some()).unwrap_or(false)
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
    pub bin: bool,
    pub gpu: bool,
    pub voices: Vec<String>,
    pub gpu_log: String,
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
    let model_len = std::fs::metadata(&model).map(|m| m.len()).unwrap_or(0);
    // INT8 quantized model (92_361_116 bytes) lacks Blackwell sm_120 CUDA kernels — will silently run Conv on CPU even with GPU pack
    if gpu_ready && model_len == 92_361_116 {
        push_tts_log("WARN: quantized model on GPU — INT8 has no sm_120 kernels, Conv ops will fallback to CPU and appear slow. For Blackwell, use FP32 model.onnx (325 MB) for full GPU.".to_string());
    }
    push_tts_log(format!(
        "Kokoro init: provider={}, gpu_pack={}, model={} ({} bytes), voices={}",
        provider, gpu_ready, model.display(), model_len, voices_path.display()
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
pub(crate) fn clear_kokoro_cache() {
    if let Some(m) = KOKORO.get() {
        // best-effort: clear cached instance so next tts_speak re-loads new model
        if let Ok(mut g) = m.try_lock() {
            *g = None;
        }
    }
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
    if !kokoro_voice_installed(&kvoice) {
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
        Ok::<Vec<u8>, String>(crate::voice::pcm_f32_to_wav_bytes(&samples, 24000))
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))??;
    Ok(wav)
}

// warm Kokoro and keep it on GPU — call once at startup / voice change so
// the first utterance doesn't pay model load. Stays in KOKORO OnceLock.
#[tauri::command]
pub async fn tts_warm() -> Result<String, String> {
    let tts = get_kokoro().await?;
    // dummy synth to force CUDA kernels to JIT-load (first synth is slower)
    let v = kokoro_en::Voice::new("af_heart".to_string()).with_speed(1.0);
    let _ = tts.synth("warmup.".to_string(), v).await;
    Ok("warm".into())
}

// PCM path — returns raw i16 LE mono at 24000 Hz via Channel, no WAV header.
// Frontend builds AudioBuffer directly (zero WAV encode/decode, smaller IPC than WAV).
#[tauri::command]
pub async fn tts_speak_pcm(
    text: String,
    voice: String,
    speed: Option<f64>,
) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() || text.len() > 20_000 {
        return Err("bad speak text".into());
    }
    if !kokoro_model_path().exists() {
        return Err(format!("kokoro not installed — set it up in Settings > Voice (missing {})", kokoro_model_path().display()));
    }
    let kvoice = map_piper_to_kokoro(&voice);
    if !kokoro_voice_installed(&kvoice) {
        return Err(format!("kokoro voice {} not installed — download it in Settings > Voice › Voices (missing {})", kvoice, kokoro_voice_path(&kvoice).display()));
    }
    let sp = speed.unwrap_or(1.0).clamp(0.5, 2.0) as f32;
    let tts = get_kokoro().await?;
    let v = kokoro_en::Voice::new(kvoice.clone()).with_speed(sp);
    let txt_len = text.len();
    let pcm_bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let start = Instant::now();
        let rt = tokio::runtime::Handle::try_current();
        let fut = async {
            let (samples, _) = tts.synth(text.clone(), v).await.map_err(|e| e.to_string())?;
            Ok::<Vec<f32>, String>(samples)
        };
        let samples = if let Ok(h) = rt { h.block_on(fut)? } else {
            tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?.block_on(fut)?
        };
        let elapsed = start.elapsed().as_millis();
        let secs = samples.len() as f32 / 24000.0;
        push_tts_log(format!("synth pcm ok: {} chars → {:.1}s audio in {}ms", txt_len, secs, elapsed));
        // f32 → i16 LE raw
        let mut out = Vec::with_capacity(samples.len() * 2);
        for s in samples { let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16; out.extend_from_slice(&v.to_le_bytes()); }
        Ok::<Vec<u8>, String>(out)
    }).await.map_err(|e| format!("task join failed: {e}"))??;
    Ok(pcm_bytes)
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
