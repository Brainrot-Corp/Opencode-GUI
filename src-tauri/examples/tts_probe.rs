use std::path::PathBuf;

fn home() -> PathBuf {
    let base = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    PathBuf::from(base)
        .join(".config")
        .join(".opencode-gui")
        .join("kokoro")
}

// mirrors the app: put the gpu dll dir into the legacy DLL search order so
// ORT's own provider load resolves cublas/cudnn from it
#[cfg(windows)]
fn preload_gpu_dlls(dir: &PathBuf) {
    use windows::core::HSTRING;
    use windows::Win32::System::LibraryLoader::SetDllDirectoryW;
    unsafe {
        if !SetDllDirectoryW(&HSTRING::from(dir.as_os_str())).is_ok() {
            eprintln!("SetDllDirectoryW failed");
        } else {
            eprintln!("SetDllDirectoryW({})", dir.display());
        }
    }
}

// usage: tts_probe [model] [text] [voice]
// KOKORO_ORT_PROVIDER is honored (unset = crate default `auto`)
#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let model = args
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("model.onnx"));
    let voices = home().join("voices");

    let gpu = home().join("gpu-dlls");
    if gpu.exists() {
        #[cfg(windows)]
        preload_gpu_dlls(&gpu);
    }

    eprintln!(
        "KOKORO_ORT_PROVIDER={}",
        std::env::var("KOKORO_ORT_PROVIDER").unwrap_or_else(|_| "auto".into())
    );
    eprintln!("loading KokoroTts from {}...", model.display());
    let tts = kokoro_en::KokoroTts::new(&model, &voices)
        .await
        .expect("kokoro init failed");
    eprintln!("init OK, synthesizing...");

    let text = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "Hello from kokoro, this is a crash test.".into());
    let voice = args.get(2).cloned().unwrap_or_else(|| "af_heart".into());
    let v = kokoro_en::Voice::new(voice).with_speed(1.0);
    let (samples, elapsed) = tts.synth(text, v).await.expect("synth failed");
    eprintln!("synth OK: {} samples in {:?}", samples.len(), elapsed);
}
