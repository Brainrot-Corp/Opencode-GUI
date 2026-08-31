// Kokoro neural TTS — engine/model download sources, locale labels and
// voice catalog. Replaces Piper; same command names for frontend compat.
// Whisper STT catalog (below) is also here for historic reasons — it
// fetches the ggml model list from HuggingFace.
import { invoke } from "@tauri-apps/api/core";

export const WHISPER_BIN_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";
// GPU (NVIDIA cublas) build — no modern whisper.cpp release ships a Vulkan
// build, so cublas is the pick; this is the newest CUDA the releases offer
// (12.4, needs NVIDIA driver ≥ 552). Reinstalling swaps the whole bin-gpu dir
export const WHISPER_GPU_BIN_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-cublas-12.4.0-bin-x64.zip";
export const MODEL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
export const VOICE_MODELS = [
  { id: "ggml-tiny.en.bin", label: "tiny.en · 78 MB · fastest, rougher" },
  { id: "ggml-base.en.bin", label: "base.en · 148 MB · English-only" },
  { id: "ggml-small.en.bin", label: "small.en · 488 MB · best accuracy, English-only" },
  { id: "ggml-base.bin", label: "base multilingual · 148 MB · recommended" },
];

// Kokoro — low-latency neural TTS (ONNX Runtime, GPU → CPU auto).
// Use the int8 model for low latency (92 MB) — quality is near full (325 MB).
// NOTE: the smaller q8f16 variant (86 MB) access-violates onnxruntime at
// session load (hard process crash) — do not switch back to it.
export const KOKORO_MODEL_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx";
// FP32 model has full CUDA kernels for Blackwell sm_120+ (INT8 quantized lacks sm_120 kernels and falls back to slow CPU path even with GPU pack)
export const KOKORO_MODEL_URL_FP32 =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx";
export function kokoroVoiceUrl(id: string): string {
  return `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${id}.bin`;
}

// Optional CUDA pack for Kokoro GPU inference — four zips extracted to
// kokoro/gpu-dlls (~1 GB total): the onnxruntime CUDA provider plus NVIDIA's
// official CUDA 13 runtime, cuBLAS and cuDNN 9 redistributables. First synth
// after install self-tests the GPU and falls back to CPU automatically.
// Two ORT provider variants cover all NVIDIA generations: pre-Blackwell
// (Ada/Hopper etc., official 1.28.0, CUDA 13.0 / cuDNN 9.13) and Blackwell
// sm_120 (community 1.24.1 built with CMAKE_CUDA_ARCHITECTURES=120,
// CUDA 13.1 / cuDNN 9.19, driver ≥591).
const KOKORO_GPU_PARTS_BASE: { key: string; url: string; label: string }[] = [
  {
    key: "kokoro-gpu-cudart",
    url: "https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-13.0.96-archive.zip",
    label: "CUDA pack · cudart",
  },
  {
    key: "kokoro-gpu-cublas",
    url: "https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-13.1.0.3-archive.zip",
    label: "CUDA pack · cuBLAS",
  },
  {
    key: "kokoro-gpu-cudnn",
    url: "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-9.13.1.26_cuda13-archive.zip",
    label: "CUDA pack · cuDNN",
  },
];
const KOKORO_GPU_PARTS_BLACKWELL_BASE: { key: string; url: string; label: string }[] = [
  {
    key: "kokoro-gpu-cudart",
    url: "https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-13.1.80-archive.zip",
    label: "CUDA pack · cudart (Blackwell)",
  },
  {
    key: "kokoro-gpu-cublas",
    url: "https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-13.1.0.3-archive.zip",
    label: "CUDA pack · cuBLAS (Blackwell)",
  },
  {
    key: "kokoro-gpu-cudnn",
    url: "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-9.19.0.56_cuda13-archive.zip",
    label: "CUDA pack · cuDNN 9.19 (Blackwell)",
  },
];
export const KOKORO_GPU_PARTS: { key: string; url: string; label: string }[] = [
  {
    key: "kokoro-gpu-ort",
    url: "https://files.pythonhosted.org/packages/e5/9e/92554acd080db68f549fd0e653fcf51a9dea7cb31e70c497714a9f2310fc/onnxruntime_gpu-1.28.0-cp312-cp312-win_amd64.whl",
    label: "CUDA pack · onnxruntime provider",
  },
  ...KOKORO_GPU_PARTS_BASE,
];
export const KOKORO_GPU_PARTS_BLACKWELL: { key: string; url: string; label: string }[] = [
  {
    key: "kokoro-gpu-ort",
    url: "https://github.com/Natfii/onnxruntime-gpu-blackwell/releases/download/v1.24.1/onnxruntime_gpu-1.24.1-cp312-cp312-win_amd64.whl",
    label: "CUDA pack · onnxruntime provider (Blackwell sm_120)",
  },
  ...KOKORO_GPU_PARTS_BLACKWELL_BASE,
];
// ~sums shown on the install button
export const KOKORO_GPU_MB = 986;
export const KOKORO_GPU_MB_BLACKWELL = 1010;
export function kokoroGpuPartsFor(computeCap: string): { key: string; url: string; label: string }[] {
  const v = parseFloat(computeCap);
  return v >= 12.0 ? KOKORO_GPU_PARTS_BLACKWELL : KOKORO_GPU_PARTS;
}
export function kokoroGpuMbFor(computeCap: string): number {
  return parseFloat(computeCap) >= 12.0 ? KOKORO_GPU_MB_BLACKWELL : KOKORO_GPU_MB;
}
// Kokoro voices — curated 26 from hexgrad/Kokoro-82M, 9 languages. IDs are
// the file-stem names in voices.bin (e.g. "af_heart").
export const KOKORO_VOICES = [
  "af_heart", "af_bella", "af_sarah", "af_nicole", "af_sky",
  "am_adam", "am_michael",
  "bf_emma", "bf_isabella", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "em_santa",
  "ff_siwis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
  "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
  "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
];

export const KOKORO_LANGS: Record<string, string> = {
  af: "US English (F)",
  am: "US English (M)",
  bf: "British English (F)",
  bm: "British English (M)",
  ef: "Spanish (F)",
  em: "Spanish (M)",
  ff: "French (F)",
  hf: "Hindi (F)",
  hm: "Hindi (M)",
  if: "Italian (F)",
  im: "Italian (M)",
  jf: "Japanese (F)",
  jm: "Japanese (M)",
  pf: "Portuguese (F)",
  pm: "Portuguese (M)",
  zf: "Chinese (F)",
  zm: "Chinese (M)",
};

export function kokoroLabel(id: string): string {
  const [prefix, name] = id.split("_");
  const lang = KOKORO_LANGS[prefix] ?? prefix;
  return `${name} · ${lang}`;
}

// --- whisper STT model catalog — live-fetch from HF, localStorage cache, static slice fallback
const WHISPER_CATALOG_API = "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main";
const WHISPER_CACHE_KEY = "oc.whisper.catalog";
const CACHE_TTL = 7 * 24 * 3600 * 1000;

export type WhisperModel = { id: string; label: string };
type WhisperFile = { id: string; size: number };

// pure parser — node tests exercise this directly. keeps real engine models
// (skips CoreML dumps and CI fixtures), smallest download first
export function parseWhisperCatalog(body: string): WhisperFile[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(j)) return [];
  const out = new Map<string, number>();
  for (const f of j) {
    const e = f as { path?: unknown; size?: unknown };
    if (
      typeof e.path !== "string" ||
      !e.path.startsWith("ggml-") ||
      !e.path.endsWith(".bin") ||
      e.path.includes(".ml.") ||
      e.path.startsWith("for-tests")
    )
      continue;
    out.set(e.path, typeof e.size === "number" ? e.size : 0);
  }
  return [...out].map(([id, size]) => ({ id, size })).sort((a, b) => a.size - b.size);
}

// "ggml-large-v3-turbo-q5_0.bin" → "large-v3-turbo-q5_0 · 548 MB · fast"
export function whisperLabel(id: string, size: number): string {
  const name = id.replace(/^ggml-/, "").replace(/\.bin$/, "");
  const hints: string[] = [];
  if (/\.en$/.test(name)) hints.push("English-only");
  if (name.includes("turbo")) hints.push("fast");
  const mb = size > 0 ? `${Math.round(size / 1048576)} MB` : "";
  return [name, mb, ...hints].filter(Boolean).join(" · ");
}

// tiny | base | small | medium | large — browser grouping key
export function wmGroup(id: string): string {
  return id.replace(/^ggml-/, "").split(/[.-]/)[0];
}

type Page = { body: string; link: string };

// cached model list; falls back to the curated static slice offline
export async function loadWhisperCatalog(force = false): Promise<WhisperModel[]> {
  if (!force) {
    try {
      const raw = localStorage.getItem(WHISPER_CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; models: WhisperModel[] };
        if (Array.isArray(c.models) && c.models.length > 0 && Date.now() - c.at < CACHE_TTL)
          return c.models;
      }
    } catch {}
  }
  try {
    const r = await invoke<Page>("http_json", {
      method: "GET",
      url: WHISPER_CATALOG_API,
      headers: {},
      body: null,
    });
    const models = parseWhisperCatalog(r.body).map((e) => ({
      id: e.id,
      label: whisperLabel(e.id, e.size),
    }));
    if (models.length) {
      localStorage.setItem(WHISPER_CACHE_KEY, JSON.stringify({ at: Date.now(), models }));
      return models;
    }
  } catch {}
  return [...VOICE_MODELS];
}

// Kokoro — single voices file covers all voices; no HF tree walk needed
export async function loadKokoroCatalog(): Promise<string[]> {
  return [...KOKORO_VOICES];
}
export function kokoroModelUrl(): string { return KOKORO_MODEL_URL; }

// legacy Piper catalog parser — kept for kokoro.test.ts (no longer used in app)
export function parsePiperCatalog(body: string): string[] {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(j)) return [];
  const out = new Set<string>();
  for (const f of j) {
    const p = (f as { path?: unknown })?.path;
    if (typeof p === "string" && p.endsWith(".onnx")) {
      out.add(p.split("/").pop()!.replace(/\.onnx$/, ""));
    }
  }
  return [...out].sort();
}
