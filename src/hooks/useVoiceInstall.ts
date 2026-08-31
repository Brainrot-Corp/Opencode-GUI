import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./useSettings";
import {
  WHISPER_BIN_URL,
  WHISPER_GPU_BIN_URL,
  MODEL_BASE,
  VOICE_MODELS,
  KOKORO_MODEL_URL,
  KOKORO_VOICES,
  kokoroGpuPartsFor,
  kokoroVoiceUrl,
} from "../lib/kokoro";

const SAMPLE_TEXT = "Hey, this is how I will read replies aloud.";

type EngineState = { bin: boolean; items: string[]; gpuBin?: boolean };
// Rust returns {bin, gpu_bin, models} from voice_status and {bin, gpu, voices}
// from tts_status — normalize both into one shape here so callers never see it
// (gpu_bin = whisper GPU engine, gpu = kokoro CUDA pack → both `gpuBin`)
type RawStatus = { bin?: boolean; gpu_bin?: boolean; gpu?: boolean; models?: string[]; voices?: string[] };

function normStatus(s?: RawStatus | null): EngineState {
  return { bin: !!s?.bin, gpuBin: !!(s?.gpu_bin || s?.gpu), items: [...(s?.models ?? s?.voices ?? [])] };
}

// shared download/install pipeline for whisper STT + Kokoro TTS — used by both
// the VoicesDialog and the first-launch Onboarding wizard. Public ops never
// throw: they surface errors in `err` and resolve false so multi-step flows
// can abort cleanly.
export function useVoiceInstall(
  settings: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
) {
  const [voice, setVoice] = useState<EngineState | null>(null);
  const [piper, setPiper] = useState<EngineState | null>(null);
  const [dl, setDl] = useState<{ label: string; pct: number } | null>(null);
  const [err, setErr] = useState("");
  const previewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => previewRef.current?.pause(), []);

  // live volume: sliders retune a running preview via oc:tts-vol
  useEffect(() => {
    const set = (e: Event) => {
      if (previewRef.current) previewRef.current.volume = (e as CustomEvent<number>).detail;
    };
    window.addEventListener("oc:tts-vol", set);
    return () => window.removeEventListener("oc:tts-vol", set);
  }, []);

  async function refresh() {
    invoke<RawStatus>("voice_status")
      .then((s) => setVoice(normStatus(s)))
      .catch(() => setVoice({ bin: false, items: [] }));
    invoke<RawStatus>("tts_status")
      .then((s) => setPiper(normStatus(s)))
      .catch(() => setPiper({ bin: false, items: [] }));
  }

  // curl.exe does the fetching Rust-side (webview fetch dies on signed-CDN
  // CORS redirects); progress is indeterminate until curl reports
  async function downloadTo(key: string, url: string, label: string) {
    setErr("");
    setDl({ label, pct: -1 });
    try {
      await invoke("voice_download", { key, url });
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    } finally {
      setDl(null);
    }
  }

  // whisper engine zip + one ggml model; skips whatever is already installed.
  // URL overrides (from the remote recommended.json) replace built-in sources
  async function installWhisper(
    modelId: string = settings.voice.model || VOICE_MODELS[1].id,
    urls?: { binUrl?: string; modelUrl?: string },
  ): Promise<boolean> {
    if (!voice?.bin) {
      if (!(await downloadTo("whisper-bin", urls?.binUrl ?? WHISPER_BIN_URL, "voice engine")))
        return false;
      try {
        await invoke("install_bin_finalize", { key: "whisper-bin" });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setVoice((v) => ({ bin: true, gpuBin: v?.gpuBin, items: v?.items ?? [] }));
    }
    if (!voice?.items.includes(modelId)) {
      // label is the bare model id — VoicesDialog matches it to mark the
      // downloading row
      if (!(await downloadTo(modelId, urls?.modelUrl ?? MODEL_BASE + modelId, modelId)))
        return false;
      try {
        await invoke("install_model_finalize", { key: modelId, name: modelId });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setVoice((v) => ({ bin: v?.bin ?? false, gpuBin: v?.gpuBin, items: [...(v?.items ?? []), modelId] }));
    }
    update({ voice: { ...settings.voice, model: modelId } });
    return true;
  }

  // NVIDIA cublas engine → bin-gpu/ (install_bin_finalize {gpu:true}); flips
  // settings.voice.gpu on success. force=true re-downloads the latest build
  // over the existing one (engine upgrades); transcribe reports per utterance
  // which engine actually ran and why, if any
  async function installWhisperGpu(force = false): Promise<boolean> {
    if (dl) return false;
    if (!voice?.gpuBin || force) {
      if (!(await downloadTo("whisper-gpu-bin", WHISPER_GPU_BIN_URL, "GPU voice engine")))
        return false;
      try {
        await invoke("install_bin_finalize", { key: "whisper-gpu-bin", gpu: true });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setVoice((v) => ({ bin: v?.bin ?? false, gpuBin: true, items: v?.items ?? [] }));
    }
    update({ voice: { ...settings.voice, gpu: true } });
    return true;
  }

  // plays a short sample — Kokoro voices are bare IDs (af_heart).
  function previewVoice(value: string): boolean {
    let v = value?.replace(/\.onnx$/, "") ?? "";
    if (!v) {
      const first = piper?.items[0] ?? "";
      if (!first) {
        setErr("no neural voice yet — install Kokoro in the Voices tab");
        return false;
      }
      v = first.replace(/\.onnx$/, "");
    }
    if (!v) {
      setErr("no neural voice yet — install Kokoro in the Voices tab");
      return false;
    }
    previewRef.current?.pause();
    invoke<number[]>("tts_speak", { text: SAMPLE_TEXT, voice: v, speed: settings.ttsSpeed })
      .then((bytes) => {
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
        );
        const a = new Audio(url);
        a.volume = settings.ttsVol;
        previewRef.current = a;
        a.onended = () => URL.revokeObjectURL(url);
        a.play().catch((e) => setErr(`audio playback failed: ${e}`));
      })
      .catch((e) => setErr(String(e)));
    return true;
  }

  // Kokoro — single model + voices.bin covers all voices
  async function ensurePiper(id: string, _urls?: any): Promise<boolean> {
    if (dl) return false;
    if (!KOKORO_VOICES.includes(id)) {
      setErr(`unknown voice ${id}`);
      return false;
    }
    if (!piper?.bin) {
      if (!(await downloadTo("kokoro-model", KOKORO_MODEL_URL, "kokoro model")))
        return false;
      try {
        await invoke("install_piper_bin", { key: "kokoro-model" });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setPiper((t) => ({ bin: true, items: t?.items ?? [] }));
    }
    if (!(piper?.items ?? []).includes(id)) {
      if (!(await downloadTo(`kokoro-${id}`, kokoroVoiceUrl(id), `${id} · voice`)))
        return false;
      try {
        await invoke("install_tts_voice_part", { key: `kokoro-${id}`, name: `${id}.bin` });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setPiper((t) => ({ bin: true, items: [...(t?.items ?? []), id].sort() }));
    }
    update({ ttsVoice: id });
    previewVoice(id);
    return true;
  }

  // deletes the GPU engine dir and turns the gpu preference off so the row
  // reflects reality; transcribe would fall back to CPU anyway
  async function removeGpuEngine(): Promise<boolean> {
    setErr("");
    try {
      await invoke("voice_remove_gpu");
      setVoice((v) => ({ bin: v?.bin ?? false, gpuBin: false, items: v?.items ?? [] }));
      if (settings.voice.gpu) update({ voice: { ...settings.voice, gpu: false } });
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }

  async function removeModel(name: string): Promise<boolean> {
    setErr("");
    try {
      await invoke("voice_remove_model", { name });
      const left = (voice?.items ?? []).filter((m) => m !== name);
      setVoice((v) => ({ bin: v?.bin ?? false, gpuBin: v?.gpuBin, items: left }));
      if (settings.voice.model === name) {
        update({ voice: { ...settings.voice, model: left[0] ?? VOICE_MODELS[1].id } });
      }
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }

  async function removePiperVoice(id: string): Promise<boolean> {
    setErr("");
    try {
      await invoke("tts_remove_voice", { name: `${id}.bin` });
      const left = (piper?.items ?? []).filter((v) => v !== id);
      setPiper((t) => ({ bin: t?.bin ?? false, items: left }));
      if (settings.ttsVoice === id || settings.ttsVoice === `${id}.onnx`) update({ ttsVoice: "" });
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }

  async function installKokoro(): Promise<boolean> {
    if (dl) return false;
    if (piper?.bin) return true;
    if (!(await downloadTo("kokoro-model", KOKORO_MODEL_URL, "kokoro model"))) return false;
    try {
      await invoke("install_piper_bin", { key: "kokoro-model" });
    } catch (e) {
      setErr(String(e));
      return false;
    }
    // also need at least one voice for TTS to be usable — install default af_heart
    if (!(await downloadTo("kokoro-af_heart", kokoroVoiceUrl("af_heart"), "af_heart · voice"))) return false;
    try {
      await invoke("install_tts_voice_part", { key: "kokoro-af_heart", name: "af_heart.bin" });
    } catch (e) {
      setErr(String(e));
      return false;
    }
    setPiper({ bin: true, items: ["af_heart"] });
    update({ ttsVoice: "af_heart" });
    return true;
  }

  async function reinstallKokoro(): Promise<boolean> {
    if (dl) return false;
    if (!(await downloadTo("kokoro-model", KOKORO_MODEL_URL, "kokoro model"))) return false;
    try {
      await invoke("install_piper_bin", { key: "kokoro-model" });
    } catch (e) {
      setErr(String(e));
      return false;
    }
    // re-download default voice as well
    if (!(await downloadTo("kokoro-af_heart", kokoroVoiceUrl("af_heart"), "af_heart · voice"))) return false;
    try {
      await invoke("install_tts_voice_part", { key: "kokoro-af_heart", name: "af_heart.bin" });
    } catch (e) {
      setErr(String(e));
      return false;
    }
    setPiper({ bin: true, items: ["af_heart"] });
    return true;
  }

  async function removeKokoro(): Promise<boolean> {
    setErr("");
    try {
      await invoke("kokoro_remove_engine");
      setPiper({ bin: false, items: [] });
      if (KOKORO_VOICES.includes(settings.ttsVoice) || KOKORO_VOICES.includes(settings.ttsVoice.replace(/\.onnx$/, ""))) {
        update({ ttsVoice: "" });
      }
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }

  // optional CUDA pack (ort provider + NVIDIA cudart/cuBLAS/cuDNN) →
  // kokoro/gpu-dlls; first synth self-tests the GPU and falls back to CPU
  // automatically. Picks Blackwell vs pre-Blackwell ORT provider by compute
  // cap (≥12.0 → sm_120). force=true re-downloads all four parts
  async function installKokoroGpu(force = false, computeCap = ""): Promise<boolean> {
    if (dl) return false;
    if (piper?.gpuBin && !force) return true;
    // resolve compute cap: explicit arg wins, else probe live via voice_gpu
    let cap = computeCap;
    if (!cap) {
      try {
        const g = await invoke<{ nvidia: boolean; compute_cap: string }>("voice_gpu");
        cap = g.compute_cap ?? "";
      } catch {}
    }
    for (const part of kokoroGpuPartsFor(cap)) {
      if (!(await downloadTo(part.key, part.url, part.label))) return false;
      try {
        await invoke("install_kokoro_gpu_part", { key: part.key });
      } catch (e) {
        setErr(String(e));
        return false;
      }
    }
    setPiper((t) => ({ bin: t?.bin ?? false, gpuBin: true, items: t?.items ?? [] }));
    return true;
  }

  async function removeKokoroGpu(): Promise<boolean> {
    setErr("");
    try {
      await invoke("tts_gpu_remove");
      setPiper((t) => ({ bin: t?.bin ?? false, gpuBin: false, items: t?.items ?? [] }));
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    }
  }

  return {
    voice,
    piper,
    dl,
    err,
    setErr,
    busy: !!dl,
    refresh,
    installWhisper,
    installWhisperGpu,
    removeGpuEngine,
    ensurePiper,
    removeModel,
    removePiperVoice,
    previewVoice,
    installKokoro,
    reinstallKokoro,
    removeKokoro,
    installKokoroGpu,
    removeKokoroGpu,
  };
}
