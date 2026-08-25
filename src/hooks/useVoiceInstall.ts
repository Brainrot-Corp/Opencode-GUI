import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./useSettings";
import {
  WHISPER_BIN_URL,
  MODEL_BASE,
  VOICE_MODELS,
  PIPER_BIN_URL,
  piperUrl,
} from "../lib/piper";

const SAMPLE_TEXT = "Hey, this is how I will read replies aloud.";

type EngineState = { bin: boolean; items: string[] };
// Rust returns {bin, models} from voice_status and {bin, voices} from
// tts_status — normalize both into one shape here so callers never see it
type RawStatus = { bin?: boolean; models?: string[]; voices?: string[] };

function normStatus(s?: RawStatus | null): EngineState {
  return { bin: !!s?.bin, items: [...(s?.models ?? s?.voices ?? [])] };
}

// shared download/install pipeline for whisper STT + piper TTS — used by both
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
    const model =
      VOICE_MODELS.find((m) => m.id === modelId) ?? { id: modelId, label: modelId };
    if (!voice?.bin) {
      if (!(await downloadTo("whisper-bin", urls?.binUrl ?? WHISPER_BIN_URL, "voice engine")))
        return false;
      try {
        await invoke("install_bin_finalize", { key: "whisper-bin" });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setVoice((v) => ({ bin: true, items: v?.items ?? [] }));
    }
    if (!voice?.items.includes(model.id)) {
      if (
        !(await downloadTo(
          model.id,
          urls?.modelUrl ?? MODEL_BASE + model.id,
          model.label ?? model.id,
        ))
      )
        return false;
      try {
        await invoke("install_model_finalize", { key: model.id, name: model.id });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setVoice((v) => ({ bin: v?.bin ?? false, items: [...(v?.items ?? []), model.id] }));
    }
    update({ voice: { ...settings.voice, model: model.id } });
    return true;
  }

  // plays a short sample through the given piper voice — value is "<id>.onnx".
  // falls back to the first downloaded voice so the button never dead-ends
  function previewVoice(value: string): boolean {
    const v = value || (piper?.items.length ? `${piper.items[0]}.onnx` : "");
    if (!v) {
      setErr("no neural voice yet — install Piper and download one in the Voices tab");
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

  // fetches whatever is missing (engine first, then the onnx + json sidecar
  // pair), then selects and previews it
  async function ensurePiper(
    id: string,
    urls?: { binUrl?: string; voiceUrl?: string; cfgUrl?: string },
  ): Promise<boolean> {
    if (dl) return false;
    if (!piper?.bin) {
      if (!(await downloadTo("piper-bin", urls?.binUrl ?? PIPER_BIN_URL, "piper engine")))
        return false;
      try {
        await invoke("install_piper_bin", { key: "piper-bin" });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setPiper((t) => ({ bin: true, items: t?.items ?? [] }));
    }
    if (!(piper?.items ?? []).includes(id)) {
      if (!(await downloadTo(`tts-${id}`, urls?.voiceUrl ?? piperUrl(id), `${id} · voice`)))
        return false;
      if (
        !(await downloadTo(
          `tts-${id}-cfg`,
          urls?.cfgUrl ?? piperUrl(id, ".onnx.json"),
          `${id} · config`,
        ))
      )
        return false;
      try {
        await invoke("install_tts_voice_part", { key: `tts-${id}`, name: `${id}.onnx` });
        await invoke("install_tts_voice_part", {
          key: `tts-${id}-cfg`,
          name: `${id}.onnx.json`,
        });
      } catch (e) {
        setErr(String(e));
        return false;
      }
      setPiper((t) => ({ bin: true, items: [...(t?.items ?? []), id].sort() }));
    }
    update({ ttsVoice: `${id}.onnx` });
    previewVoice(`${id}.onnx`);
    return true;
  }

  async function removeModel(name: string): Promise<boolean> {
    setErr("");
    try {
      await invoke("voice_remove_model", { name });
      const left = (voice?.items ?? []).filter((m) => m !== name);
      setVoice((v) => ({ bin: v?.bin ?? false, items: left }));
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
      await invoke("tts_remove_voice", { name: `${id}.onnx` });
      const left = (piper?.items ?? []).filter((v) => v !== id);
      setPiper((t) => ({ bin: t?.bin ?? false, items: left }));
      if (settings.ttsVoice === `${id}.onnx`) update({ ttsVoice: "" });
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
    ensurePiper,
    removeModel,
    removePiperVoice,
    previewVoice,
  };
}
