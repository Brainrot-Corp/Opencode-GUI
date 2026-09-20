// Speech-to-text: whisper CLI per-inference path + persistent whisper-server
// (GPU cublas build) with CPU fallback, plus the NVIDIA GPU probe.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{pcm_f32_to_wav_bytes, unique_temp_path};

// everything lives under config_root/whisper — same root as themes/plugins
pub(crate) fn whisper_dir() -> PathBuf {
    crate::platform::home_dir()
        .join(".config")
        .join(".opencode-gui")
        .join("whisper")
}

pub(crate) fn bin_dir() -> PathBuf {
    whisper_dir().join("bin")
}

// separate GPU engine dir (cublas build) so CPU/GPU installs can coexist —
// transcribe picks per call and falls back to the CPU one on failure
pub(crate) fn bin_gpu_dir() -> PathBuf {
    whisper_dir().join("bin-gpu")
}

pub(crate) fn models_dir() -> PathBuf {
    whisper_dir().join("models")
}

pub(crate) fn find_cli_in(dir: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        for name in ["whisper-cli.exe", "main.exe"] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for name in ["whisper-cli", "whisper-cli.exe", "main", "main.exe"] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
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
    pub bin: bool,
    pub gpu_bin: bool,
    pub models: Vec<String>,
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
    pub nvidia: bool,
    pub name: String,
    /// e.g. "12.0" for Blackwell sm_120, "8.9" for Ada — empty if unknown
    pub compute_cap: String,
}

#[tauri::command]
pub async fn voice_gpu() -> GpuStatus {
    #[cfg(not(windows))]
    {
        // CPU-only outside Windows for now; CoreML/MPS deferred
        return GpuStatus { nvidia: false, name: String::new(), compute_cap: String::new() };
    }
    #[cfg(windows)]
    {
        let (nvidia, compute_cap) = tauri::async_runtime::spawn_blocking(|| -> (Option<String>, String) {
            let name = (|| {
                let mut cmd = crate::platform::win_command("powershell");
                cmd.args([
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
                ]);
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
                let mut cmd = crate::platform::win_command("nvidia-smi");
                cmd.args(["--query-gpu=compute_cap", "--format=csv,noheader,nounits"]);
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
}

// what voice_transcribe hands back — text plus which engine actually did the
// work ("gpu" | "cpu") and why it fell back, so the UI can show the truth
#[derive(serde::Serialize)]
pub struct TranscribeOut {
    pub text: String,
    pub engine: String,
    pub note: String,
}

// one whisper-cli invocation with the GPU→CPU engine selection, the crash
// fallback and the "gpu build ran without cuda" sniff — shared by
// voice_transcribe and voice_transcribe_pcm's CLI fallback. Blocking (spawns
// and polls the CLI); only call from spawn_blocking.
fn transcribe_via_cli(mp: &Path, tmp: &Path, translate: bool, want_gpu: bool) -> Result<TranscribeOut, String> {
    let gpu_cli = find_gpu_cli();
    let cpu_cli = find_cli();
    // GPU requested but no GPU engine installed → use the CPU one; a GPU
    // engine that spawns but fails at runtime falls back below
    let primary = if want_gpu {
        gpu_cli.clone().or_else(|| cpu_cli.clone())
    } else {
        cpu_cli.clone()
    }
    .ok_or_else(|| "voice engine not installed — set it up in Settings > Voice".to_string())?;
    let want_gpu_actual = Some(&primary) == gpu_cli.as_ref();
    let cpu_fallback = if want_gpu_actual { cpu_cli.clone() } else { None };
    let mut engine = if want_gpu_actual { "gpu" } else { "cpu" };
    let mut note = String::new();
    let (text, stderr) = match run_whisper(&primary, mp, tmp, translate) {
        Ok(v) => v,
        Err(e) => {
            match cpu_fallback {
                // engine crashed (old driver, missing CUDA dlls) → retry on CPU
                Some(cpu) => {
                    engine = "cpu";
                    note = format!("engine failed: {e}");
                    eprintln!("[STT] transcribe_via_cli CPU fallback after: {e}");
                    run_whisper(&cpu, mp, tmp, translate)?
                }
                None => return Err(e),
            }
        },
    };
    if engine == "gpu" {
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
            eprintln!("[STT] transcribe_via_cli gpu build ran without cuda tail={}", tail);
        }
    }
    Ok(TranscribeOut { text, engine: engine.into(), note })
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
    eprintln!("[STT] voice_transcribe start model={} audio={} gpu={:?} translate={:?}", model, audio.len(), gpu, translate);
    if !model.ends_with(".bin") || model.contains("..") {
        return Err("bad model name".into());
    }
    let mp = models_dir().join(&model);
    if !mp.exists() {
        eprintln!("[STT] voice_transcribe model missing {}", mp.display());
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
    eprintln!("[STT] voice_transcribe tmp={} len={}", tmp.display(), audio.len());

    let tr = translate.unwrap_or(false);
    let want_gpu = gpu.unwrap_or(false);
    // EH-10+TF-02: offload blocking wait to dedicated pool; single wait without double-reap
    let mp2 = mp.clone();
    let tmp2 = tmp.clone();
    let blocking = tauri::async_runtime::spawn_blocking(move || {
        eprintln!("[STT] voice_transcribe blocking start want_gpu={}", want_gpu);
        transcribe_via_cli(&mp2, &tmp2, tr, want_gpu)
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))?;

    let _ = std::fs::remove_file(&tmp);
    eprintln!("[STT] voice_transcribe done text_len={} engine={}", blocking.as_ref().map(|o| o.text.len()).unwrap_or(0), blocking.as_ref().map(|o| o.engine.clone()).unwrap_or_default());
    blocking
}

// ---------- Streaming STT helpers — PCM path + persistent backend ----------

fn find_server_in(dir: &Path) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["whisper-server.exe", "server.exe", "whisper-server"]
    } else {
        &["whisper-server", "whisper-server.exe", "server", "server.exe"]
    };
    for name in names {
        let p = dir.join(name);
        if p.exists() { return Some(p); }
        let p2 = dir.join("Release").join(name);
        if p2.exists() { return Some(p2); }
    }
    None
}
fn find_server() -> Option<PathBuf> { find_server_in(&bin_dir()) }
fn find_gpu_server() -> Option<PathBuf> { find_server_in(&bin_gpu_dir()) }

struct WhisperServer {
    port: u16,
    child: std::process::Child,
    model: String,
    gpu: bool,
}
static WHISPER_SERVER: std::sync::OnceLock<Mutex<Option<WhisperServer>>> = std::sync::OnceLock::new();
fn whisper_server_lock() -> &'static Mutex<Option<WhisperServer>> {
    WHISPER_SERVER.get_or_init(|| Mutex::new(None))
}
fn is_server_alive(s: &mut WhisperServer) -> bool {
    matches!(s.child.try_wait(), Ok(None))
}
fn kill_server(s: &mut WhisperServer) {
    let pid = s.child.id();
    eprintln!("[STT] kill_server pid={} port={} model={}", pid, s.port, s.model);
    let _ = s.child.kill();
    let _ = s.child.wait();
    eprintln!("[STT] kill_server done pid={}", pid);
}
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut c) = TcpStream::connect(format!("127.0.0.1:{port}")) {
            let _ = c.set_read_timeout(Some(Duration::from_millis(300)));
            let _ = c.set_write_timeout(Some(Duration::from_millis(300)));
            let req = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            if c.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 1024];
                if let Ok(n) = c.read(&mut buf) { if n > 0 { return true; } }
            }
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    false
}
fn ensure_whisper_server(model_path: &Path, use_gpu: bool) -> Result<u16, String> {
    let model_str = model_path.to_string_lossy().to_string();
    eprintln!("[STT] ensure_whisper_server start model={} gpu={}", model_str, use_gpu);
    // fast path / teardown under lock, then drop guard before the 10s wait so other transcribes don't block on the mutex
    {
        let mut guard = whisper_server_lock().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = guard.as_mut() {
            if s.model == model_str && s.gpu == use_gpu && is_server_alive(s) {
                eprintln!("[STT] ensure_whisper_server reuse port={} gpu={}", s.port, use_gpu);
                return Ok(s.port);
            }
            if guard.is_some() {
                eprintln!("[STT] ensure_whisper_server teardown old model={} gpu={} alive={}", guard.as_ref().map(|x| x.model.clone()).unwrap_or_default(), guard.as_ref().map(|x| x.gpu).unwrap_or(false), guard.as_mut().map(|x| is_server_alive(x)).unwrap_or(false));
                let mut old = guard.take().unwrap();
                kill_server(&mut old);
            }
        }
    }
    let bin = if use_gpu { find_gpu_server().or_else(find_server) } else { find_server().or_else(find_gpu_server) };
    let server_bin = match bin {
        Some(p) => p,
        None => {
            eprintln!("[STT] ensure_whisper_server no server binary — CLI fallback");
            return Err("whisper-server not found — falling back to CLI".into());
        }
    };
    let port = crate::platform::free_port().map_err(|e| e.to_string())?;
    eprintln!("[STT] ensure_whisper_server spawn bin={} port={} model={}", server_bin.display(), port, model_str);
    let mut cmd = crate::platform::win_command(&server_bin);
    cmd.args(["-m", &model_str, "--host", "127.0.0.1", "--port", &port.to_string()]);
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("failed to spawn whisper-server: {e}"))?;
    crate::server::job::assign(&child);
    let mut handle = WhisperServer { port, child, model: model_str.clone(), gpu: use_gpu };
    let alive = wait_for_server(port, Duration::from_secs(10));
    match handle.child.try_wait() {
        Ok(Some(st)) => {
            eprintln!("[STT] ensure_whisper_server exited early status={} port={}", st, port);
            return Err(format!("whisper-server exited early: {st}"));
        }
        Ok(None) if !alive => {
            eprintln!("[STT] ensure_whisper_server not listening port={}", port);
            kill_server(&mut handle);
            return Err("whisper-server not listening".into());
        }
        _ => {}
    }
    // re-lock to insert — handle race where another thread already started the same server while we were waiting
    {
        let mut guard = whisper_server_lock().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = guard.as_mut() {
            if s.model == model_str && s.gpu == use_gpu && is_server_alive(s) {
                eprintln!("[STT] ensure_whisper_server race win existing port={} — killing duplicate port={}", s.port, handle.port);
                kill_server(&mut handle);
                return Ok(s.port);
            }
            if let Some(mut old) = guard.take() {
                eprintln!("[STT] ensure_whisper_server replacing old port={}", old.port);
                kill_server(&mut old);
            }
        }
        let p = handle.port;
        eprintln!("[STT] ensure_whisper_server ready port={} gpu={} model={}", p, use_gpu, model_str);
        *guard = Some(handle);
        Ok(p)
    }
}
pub fn shutdown_whisper_server() {
    eprintln!("[STT] shutdown_whisper_server");
    if let Some(lock) = WHISPER_SERVER.get() {
        // poisoned lock still contains the server — recover instead of leaking it forever
        if let Ok(mut g) = lock.lock().or_else(|e| Ok::<_, String>(e.into_inner())) {
            if let Some(mut s) = g.take() { kill_server(&mut s); }
        }
    }
}

// PCM streaming transcription — persistent backend (whisper-server) with a
// CLI fallback, PCM internal, no WAV temp file unless CLI fallback. Off UI
// thread via spawn_blocking.
// Uses RTX 5080/CUDA when `gpu` true and cublas server is available.
#[tauri::command]
pub async fn voice_transcribe_pcm(
    pcm: Vec<f32>,
    model: String,
    translate: Option<bool>,
    gpu: Option<bool>,
) -> Result<TranscribeOut, String> {
    eprintln!("[STT] voice_transcribe_pcm start model={} pcm={} gpu={:?} translate={:?}", model, pcm.len(), gpu, translate);
    if !model.ends_with(".bin") || model.contains("..") {
        return Err("bad model name".into());
    }
    let mp = models_dir().join(&model);
    if !mp.exists() {
        eprintln!("[STT] voice_transcribe_pcm model missing {}", mp.display());
        return Err(format!("model {} is not downloaded", mp.display()));
    }
    if pcm.len() < (16000 * 20 / 100) { // <20ms
        eprintln!("[STT] voice_transcribe_pcm too short {} <20ms", pcm.len());
        return Ok(TranscribeOut { text: String::new(), engine: "cpu".into(), note: String::new() });
    }
    // clamp to 30s (whisper max) — rolling buffer is bounded frontend-side, but guard here
    let pcm = if pcm.len() > 16000 * 30 { pcm[pcm.len() - 16000*30 ..].to_vec() } else { pcm };
    let tr = translate.unwrap_or(false);
    let want_gpu = gpu.unwrap_or(false);
    let mp_clone = mp.clone();
    let pcm_clone = pcm.clone();
    let pcm_len = pcm_clone.len();
    // spawn_blocking keeps inference off Tauri's async pool
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<TranscribeOut, String> {
        eprintln!("[STT] voice_transcribe_pcm blocking start pcm={} want_gpu={} translate={}", pcm_len, want_gpu, tr);
        // 1) try persistent whisper-server (GPU path or CPU if server found)
        match ensure_whisper_server(&mp_clone, want_gpu) {
            Ok(port) => {
                eprintln!("[STT] voice_transcribe_pcm server hit port={} gpu={}", port, want_gpu);
                let wav = pcm_f32_to_wav_bytes(&pcm_clone, 16000);
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(30))
                    .build().map_err(|e| e.to_string())?;
                let form = reqwest::blocking::multipart::Form::new()
                    .part("file", reqwest::blocking::multipart::Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav").unwrap())
                    .text("temperature", "0.0")
                    .text("response_format", "json");
                let url = format!("http://127.0.0.1:{port}/inference");
                eprintln!("[STT] voice_transcribe_pcm server POST {}", url);
                let resp = match client.post(&url).multipart(form).send() {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[STT] voice_transcribe_pcm server request failed: {} — killing server for self-recovery", e);
                        // self-recovering: server became unresponsive — kill so next utterance restarts it
                        if let Some(lock) = WHISPER_SERVER.get() {
                            if let Ok(mut g) = lock.lock().or_else(|f| Ok::<_, String>(f.into_inner())) {
                                if let Some(mut s) = g.take() { kill_server(&mut s); }
                            }
                        }
                        return Err(format!("whisper-server request failed: {e}"));
                    }
                };
                if !resp.status().is_success() {
                    let txt = resp.text().unwrap_or_default();
                    eprintln!("[STT] voice_transcribe_pcm server inference failed: {}", txt);
                    // treat http error as server poison — kill so CLI fallback/restart succeeds next time
                    if let Some(lock) = WHISPER_SERVER.get() {
                        if let Ok(mut g) = lock.lock().or_else(|f| Ok::<_, String>(f.into_inner())) {
                            if let Some(s) = g.as_mut() {
                                if s.port == port { let mut old = g.take().unwrap(); kill_server(&mut old); }
                            }
                        }
                    }
                    return Err(format!("whisper-server inference failed: {txt}"));
                }
                let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
                let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("")
                    .lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
                let engine = if want_gpu { "gpu" } else { "cpu" };
                eprintln!("[STT] voice_transcribe_pcm server done engine={} text_len={}", engine, text.len());
                return Ok(TranscribeOut { text, engine: engine.into(), note: String::new() });
            }
            Err(e) => {
                eprintln!("[STT] voice_transcribe_pcm server miss: {} — CLI fallback", e);
            }
        }
        // 2) fallback: CLI per-inference via temp WAV (still PCM→WAV once, no frontend WAV)
        let wav = pcm_f32_to_wav_bytes(&pcm_clone, 16000);
        let tmp = unique_temp_path("oc-voice-pcm", "wav");
        {
            use std::fs::OpenOptions;
            use std::io::Write;
            let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)
                .or_else(|_| std::fs::File::create(&tmp)).map_err(|e| e.to_string())?;
            f.write_all(&wav).map_err(|e| e.to_string())?;
        }
        eprintln!("[STT] voice_transcribe_pcm CLI fallback tmp={}", tmp.display());
        let out = transcribe_via_cli(&mp_clone, &tmp, tr, want_gpu);
        // always clean up the temp wav (the old code skipped it when the CPU
        // retry itself failed)
        let _ = std::fs::remove_file(&tmp);
        eprintln!("[STT] voice_transcribe_pcm CLI done engine={}", out.as_ref().map(|o| o.engine.clone()).unwrap_or_default());
        out
    }).await.map_err(|e| format!("task join failed: {e}"))??;
    eprintln!("[STT] voice_transcribe_pcm done pcm={} engine={} text_len={}", pcm.len(), res.engine, res.text.len());
    Ok(res)
}

// one whisper-cli invocation over the temp wav — blocking, only call from
// spawn_blocking. Hard cap so a wedged process can't pin the UI mic state.
// Returns (transcription, stderr log) — stderr carries the backend/device
// lines used to verify the gpu build engaged cuda.
// All error paths log [STT] so frontend lifecycle logs can pinpoint die reason.
fn run_whisper(cli: &Path, mp: &Path, tmp: &Path, translate: bool) -> Result<(String, String), String> {
    use std::io::Read;
    eprintln!("[STT] run_whisper start cli={} tmp={} translate={}", cli.display(), tmp.display(), translate);
    let mut cmd = crate::platform::win_command(cli);
    cmd.arg("-m").arg(mp).arg("-f").arg(tmp);
    cmd.args(["-nt", "-np"]);
    if translate {
        cmd.arg("--translate");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| { eprintln!("[STT] run_whisper spawn failed: {}", e); format!("failed to run whisper-cli: {e}") })?;
    eprintln!("[STT] run_whisper spawned pid={:?} cli={}", child.id(), cli.display());
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
        match child.try_wait().map_err(|e| { eprintln!("[STT] run_whisper try_wait failed: {}", e); e.to_string() })? {
            Some(s) => {
                status = s;
                eprintln!("[STT] run_whisper child exit status={} ", s);
                break;
            }
            None => {
                if Instant::now() > deadline {
                    eprintln!("[STT] run_whisper timeout 180s — killing pid={:?}", child.id());
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
    eprintln!("[STT] run_whisper done status={} stdout={} stderr_tail={}", status, stdout.len(), String::from_utf8_lossy(&stderr).lines().rev().take(1).next().unwrap_or("").chars().take(120).collect::<String>());
    if !status.success() && stdout.is_empty() {
        let tail = String::from_utf8_lossy(&stderr)
            .lines()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .join(" | ");
        eprintln!("[STT] run_whisper failed status={} tail={}", status, tail);
        return Err(format!("whisper-cli failed ({}): {}", status, tail));
    }
    let text = String::from_utf8_lossy(&stdout);
    let clean = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!("[STT] run_whisper clean text_len={}", clean.len());
    Ok((clean, String::from_utf8_lossy(&stderr).to_string()))
}
