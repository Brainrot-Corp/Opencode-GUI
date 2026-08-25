import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../hooks/useSettings";
import PickerMenu from "./PickerMenu";

const WHISPER_BIN_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";
const MODEL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const VOICE_MODELS = [
  { id: "ggml-tiny.en.bin", label: "tiny.en · 78 MB · fastest, rougher" },
  { id: "ggml-base.en.bin", label: "base.en · 148 MB · English-only" },
  { id: "ggml-small.en.bin", label: "small.en · 488 MB · best accuracy, English-only" },
  { id: "ggml-base.bin", label: "base multilingual · 148 MB · recommended" },
];

// Piper neural TTS — exe release + curated single-speaker voices from
// huggingface.co/rhasspy/piper-voices (id layout: <lang>_<REGION>-<speaker>-<quality>)
const PIPER_BIN_URL =
  "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
const PIPER_VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/";
const PIPER_VOICES = [
  "en_US-amy-medium",
  "en_US-lessac-medium",
  "en_US-ryan-high",
  "en_GB-alba-medium",
  "en_GB-southern_english_female-low",
  "de_DE-thorsten-medium",
  "fr_FR-siwis-medium",
  "es_ES-sharvard-medium",
  "zh_CN-huayan-medium",
  "pt_BR-faber-medium",
  "pl_PL-darkman-medium",
];
function piperUrl(id: string, ext = ".onnx"): string {
  const [family, speaker, quality] = id.split("-");
  return `${PIPER_VOICE_BASE}${family.slice(0, 2)}/${family}/${speaker}/${quality}/${id}${ext}`;
}
const PIPER_LANGS: Record<string, string> = {
  en_US: "US English",
  en_GB: "British English",
  de_DE: "German",
  fr_FR: "French",
  es_ES: "Spanish",
  zh_CN: "Chinese",
  pt_BR: "Portuguese",
  pl_PL: "Polish",
};
function piperLabel(id: string): string {
  const [family, speaker, quality] = id.split("-");
  return `${speaker} (${quality}) · ${PIPER_LANGS[family] ?? family}`;
}
const PREVIEW_TEXT = "Hey, this is how I will read replies aloud.";

// Voice settings — whisper dictation engine + Piper neural TTS: install,
// download/remove models & voices, pick, preview, tune
export default function VoiceSettings({
  open,
  settings,
  update,
}: {
  open: boolean;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [voice, setVoice] = useState<{ bin: boolean; models: string[] } | null>(null);
  const [dl, setDl] = useState<{ label: string; pct: number } | null>(null);
  const [voiceErr, setVoiceErr] = useState("");
  // piper neural TTS: engine + downloaded voices (id list without .onnx)
  const [piper, setPiper] = useState<{ bin: boolean; voices: string[] } | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!open) return;
    invoke<{ bin: boolean; models: string[] }>("voice_status")
      .then(setVoice)
      .catch(() => setVoice({ bin: false, models: [] }));
    invoke<{ bin: boolean; voices: string[] }>("tts_status")
      .then(setPiper)
      .catch(() => setPiper({ bin: false, voices: [] }));

  }, [open]);

  // live volume: the slider retunes a running preview via oc:tts-vol
  useEffect(() => {
    const set = (e: Event) => {
      if (previewRef.current) previewRef.current.volume = (e as CustomEvent<number>).detail;
    };
    window.addEventListener("oc:tts-vol", set);
    return () => window.removeEventListener("oc:tts-vol", set);
  }, []);

  // curl.exe does the fetching Rust-side (webview fetch dies on signed-CDN
  // CORS redirects); progress is indeterminate until curl reports
  async function downloadTo(key: string, url: string, label: string) {
    setVoiceErr("");
    setDl({ label, pct: -1 });
    try {
      await invoke("voice_download", { key, url });
    } finally {
      setDl(null);
    }
  }

  async function installVoice() {
    const model =
      VOICE_MODELS.find((m) => m.id === settings.voice.model) ?? VOICE_MODELS[1];
    try {
      if (!voice?.bin) {
        await downloadTo("whisper-bin", WHISPER_BIN_URL, "voice engine");
        await invoke("install_bin_finalize", { key: "whisper-bin" });
        setVoice((v) => ({ bin: true, models: v?.models ?? [] }));
      }
      if (!voice?.models.includes(model.id)) {
        await downloadTo(model.id, MODEL_BASE + model.id, model.label);
        await invoke("install_model_finalize", { key: model.id, name: model.id });
        setVoice((v) => ({ bin: v?.bin ?? false, models: [...(v?.models ?? []), model.id] }));
      }
    } catch (e) {
      setVoiceErr(String(e));
    }
  }

  // removes a model file; if it was the active pick, fall back to another
  async function removeModel(name: string) {
    setVoiceErr("");
    try {
      await invoke("voice_remove_model", { name });
      const left = (voice?.models ?? []).filter((m) => m !== name);
      setVoice((v) => ({ bin: v?.bin ?? false, models: left }));
      if (settings.voice.model === name) {
        update({ voice: { ...settings.voice, model: left[0] ?? VOICE_MODELS[1].id } });
      }
    } catch (e) {
      setVoiceErr(String(e));
    }
  }


  // plays a short sample through the given piper voice — used by the picker
  // and the preview button; value is the stored "<id>.onnx" filename.
  // falls back to the first downloaded voice so the button never dead-ends
  function previewVoice(value: string) {
    const voice =
      value ||
      (piper?.voices.length ? `${piper.voices[0]}.onnx` : "");
    if (!voice) {
      setVoiceErr("no neural voice yet — install Piper and download one below");
      return;
    }
    previewRef.current?.pause();
    invoke<number[]>("tts_speak", { text: PREVIEW_TEXT, voice, speed: settings.ttsSpeed })
      .then((bytes) => {
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
        );
        const a = new Audio(url);
        a.volume = settings.ttsVol;
        previewRef.current = a;
        a.onended = () => URL.revokeObjectURL(url);
        a.play().catch((e) => setVoiceErr(`audio playback failed: ${e}`));
      })
      .catch((e) => setVoiceErr(String(e)));
  }

  // whisper-model flow: picking an unavailable voice fetches whatever is
  // missing (engine first, then the onnx + json sidecar pair), then
  // selects and previews it
  async function ensureVoice(id: string) {
    if (dl) return;
    try {
      if (!piper?.bin) {
        await downloadTo("piper-bin", PIPER_BIN_URL, "piper engine");
        await invoke("install_piper_bin", { key: "piper-bin" });
        setPiper((t) => ({ bin: true, voices: t?.voices ?? [] }));
      }
      if (!(piper?.voices ?? []).includes(id)) {
        await downloadTo(`tts-${id}`, piperUrl(id), `${id} · voice`);
        await downloadTo(`tts-${id}-cfg`, piperUrl(id, ".onnx.json"), `${id} · config`);
        await invoke("install_tts_voice_part", { key: `tts-${id}`, name: `${id}.onnx` });
        await invoke("install_tts_voice_part", { key: `tts-${id}-cfg`, name: `${id}.onnx.json` });
        setPiper((t) => ({ bin: true, voices: [...(t?.voices ?? []), id].sort() }));
      }
      update({ ttsVoice: `${id}.onnx` });
      previewVoice(`${id}.onnx`);
    } catch (e) {
      setVoiceErr(String(e));
    }
  }

  async function removePiperVoice(id: string) {
    try {
      await invoke("tts_remove_voice", { name: `${id}.onnx` });
      const left = (piper?.voices ?? []).filter((v) => v !== id);
      setPiper((t) => ({ bin: t?.bin ?? false, voices: left }));
      if (settings.ttsVoice === `${id}.onnx`) update({ ttsVoice: "" });
    } catch (e) {
      setVoiceErr(String(e));
    }
  }

  // the voice currently streaming in — derived from the shared download
  // indicator label ("<id> · voice" / "<id> · config") so the picker can
  // mark it live without extra state
  const dlVoiceId = (() => {
    const l = dl?.label ?? "";
    return l.endsWith("· voice") || l.endsWith("· config")
      ? l.slice(0, l.lastIndexOf(" · "))
      : "";
  })();

  return (
    <div className="sound-box">
      <div className="sound-box-head">
        <i className="fa-solid fa-microphone setting-icon" />
        <span>Voice</span>
        {dl ? (
          <span className="dl-live" role="status">
            <i className="fa-solid fa-download setting-icon" />
            <span className="mono-hint">{dl.label}</span>
            <span className="dl-bar">
              <span
                className={`dl-fill${dl.pct >= 0 ? " set" : ""}`}
                style={dl.pct >= 0 ? { width: `${dl.pct * 100}%` } : undefined}
              />
            </span>
          </span>
        ) : (
          <span className="mono-hint">
            {!voice?.bin
              ? "not installed"
              : voiceErr
                ? "error — see below"
                : "ready"}
          </span>
        )}
      </div>

      {voiceErr && <div className="voice-err">{voiceErr}</div>}

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-microchip setting-icon" />
          <div>
            <div className="setting-name">Speech engine</div>
            <div className="setting-desc">
              {voice?.bin
                ? `whisper.cpp ready · ${voice.models.length} model${voice.models.length === 1 ? "" : "s"} downloaded`
                : "Local whisper.cpp — downloads once, runs offline"}
            </div>
          </div>
        </div>
        <div className="color-controls">
          {(!voice?.bin || !voice.models.includes(settings.voice.model)) && (
            <button
              type="button"
              className="reset-btn"
              disabled={!!dl}
              onClick={() => void installVoice()}
            >
              <i className="fa-solid fa-download" />
              {!voice?.bin ? "Install (~10 MB)" : "Download model"}
            </button>
          )}
          <PickerMenu
            value={settings.voice.model}
            disabled={!!dl}
            label={
              VOICE_MODELS.find((m) => m.id === settings.voice.model)?.label.split(" · ")[0] ??
              "model"
            }
            entries={VOICE_MODELS.map((m) => ({
              value: m.id,
              label: m.label + (voice?.models.includes(m.id) ? "" : " — not downloaded"),
            }))}
            onPick={(v) => update({ voice: { ...settings.voice, model: v } })}
          />
        </div>
      </div>

      {voice?.models.length ? (
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-database setting-icon" />
            <div>
              <div className="setting-name">Downloaded models</div>
              <div className="setting-desc">Click × to free the disk space</div>
            </div>
          </div>
          <div className="model-chips">
            {voice.models.map((m) => (
              <span key={m} className={`model-chip${settings.voice.model === m ? " active" : ""}`}>
                {m.replace("ggml-", "").replace(".bin", "")}
                <button
                  type="button"
                  aria-label={`Remove ${m}`}
                  disabled={!!dl}
                  onClick={() => void removeModel(m)}
                >
                  <i className="fa-solid fa-xmark" />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-headset setting-icon" />
          <div>
            <div className="setting-name">Hands-free dictation</div>
            <div className="setting-desc">
              Mic stays live and listens for commands — say "prompt …" to fill
              the composer, "send …" to fill and send at once
            </div>
          </div>
        </div>
        <button
          type="button"
          className={`toggle${settings.voice.handsFree ? " on" : ""}`}
          aria-pressed={settings.voice.handsFree}
          onClick={() =>
            update({ voice: { ...settings.voice, handsFree: !settings.voice.handsFree } })
          }
        >
          <span className="knob" />
        </button>
      </div>

      {settings.voice.handsFree && (
        <>
          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-wave-square setting-icon" />
              <div>
                <div className="setting-name">Mic sensitivity</div>
                <div className="setting-desc">
                  Higher picks up quieter voices (and more background noise)
                </div>
              </div>
            </div>
            <div className="color-controls">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.voice.sens}
                aria-label="Microphone sensitivity"
                onChange={(e) =>
                  update({ voice: { ...settings.voice, sens: Number(e.target.value) } })
                }
              />
              <span className="alpha-num">{Math.round(settings.voice.sens * 100)}%</span>
            </div>
          </div>
        </>
      )}

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-language setting-icon" />
          <div>
            <div className="setting-name">Multilingual commands</div>
            <div className="setting-desc">
              No English match? Re-runs the utterance through whisper's
              translate task before giving up to dictation
            </div>
          </div>
        </div>
        <button
          type="button"
          className={`toggle${settings.voice.multilingual ? " on" : ""}`}
          aria-pressed={settings.voice.multilingual}
          onClick={() =>
            update({ voice: { ...settings.voice, multilingual: !settings.voice.multilingual } })
          }
        >
          <span className="knob" />
        </button>
      </div>

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-bug setting-icon" />
          <div>
            <div className="setting-name">Debug transcript</div>
            <div className="setting-desc">
              Show every utterance as heard, the sanitized router input, and the
              action it matched (or why it became dictation)
            </div>
          </div>
        </div>
        <button
          type="button"
          className={`toggle${settings.voice.debug ? " on" : ""}`}
          aria-pressed={settings.voice.debug}
          onClick={() => update({ voice: { ...settings.voice, debug: !settings.voice.debug } })}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-volume-high setting-icon" />
          <div>
            <div className="setting-name">Speak replies</div>
            <div className="setting-desc">
              Read assistant answers aloud (code skipped) — hands-free
              listening pauses during playback
            </div>
          </div>
        </div>
        <div className="color-controls">
          <PickerMenu
            value={settings.ttsVoice}
            disabled={!!dl}
            label={
              settings.ttsVoice
                ? piperLabel(settings.ttsVoice.replace(/\.onnx$/, ""))
                : "Pick a voice…"
            }
            entries={PIPER_VOICES.map((id) => ({
              value: `${id}.onnx`,
              label:
                piperLabel(id) +
                ((piper?.voices ?? []).includes(id)
                  ? ""
                  : id === dlVoiceId
                    ? " — downloading…"
                    : " — not downloaded"),
            }))}
            onPick={(file) => {
              const id = file.replace(/\.onnx$/, "");
              if (piper?.voices.includes(id)) {
                update({ ttsVoice: file });
                previewVoice(file);
              } else {
                void ensureVoice(id);
              }
            }}
          />
          <button
            type="button"
            className="reset-btn"
            data-tip="Preview voice"
            aria-label="Preview voice"
            disabled={!(settings.ttsVoice || piper?.voices.length)}
            onClick={() => previewVoice(settings.ttsVoice)}
          >
            <i className="fa-solid fa-play" />
          </button>
          <button
            type="button"
            className={`toggle${settings.speakReplies ? " on" : ""}`}
            aria-pressed={settings.speakReplies}
            disabled={!settings.secondaryModel || !settings.ttsVoice}
            data-tip={!settings.secondaryModel ? "Pick a Secondary model first" : !settings.ttsVoice ? "Pick a voice first" : settings.speakReplies ? "Turn off spoken replies" : "Turn on spoken replies"}
            onClick={() => {
              if (!settings.secondaryModel || !settings.ttsVoice) return;
              update({ speakReplies: !settings.speakReplies });
            }}
          >
            <span className="knob" />
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-volume-low setting-icon" />
          <div>
            <div className="setting-name">Speech volume</div>
            <div className="setting-desc">Loudness of spoken replies and previews</div>
          </div>
        </div>
        <div className="color-controls">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.ttsVol}
            aria-label="Speech volume"
            onChange={(e) => {
              const v = Number(e.target.value);
              update({ ttsVol: v });
              // retune any speech playing right now
              window.dispatchEvent(new CustomEvent("oc:tts-vol", { detail: v }));
            }}
          />
          <span className="alpha-num">{Math.round(settings.ttsVol * 100)}%</span>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-gauge-high setting-icon" />
          <div>
            <div className="setting-name">Speech speed</div>
            <div className="setting-desc">Rate of spoken replies — applies to the next phrase</div>
          </div>
        </div>
        <div className="color-controls">
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={settings.ttsSpeed}
            aria-label="Speech speed"
            onChange={(e) => update({ ttsSpeed: Number(e.target.value) })}
          />
          <span className="alpha-num">{settings.ttsSpeed.toFixed(2)}×</span>
        </div>
      </div>

      {/* piper engine + neural voice management, same pattern as whisper */}
      <div className="setting-row">
        <div className="setting-info">
          <i className="fa-solid fa-wand-magic-sparkles setting-icon" />
          <div>
            <div className="setting-name">Neural voices</div>
            <div className="setting-desc">
              {piper?.bin
                ? `Piper ready · ${piper.voices.length} voice${piper.voices.length === 1 ? "" : "s"} downloaded`
                : dl
                  ? "Downloading Piper engine…"
                  : "Pick any voice above — Piper installs on demand"}
            </div>
          </div>
        </div>

      </div>

      {!!piper?.voices.length && (
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-database setting-icon" />
            <div>
              <div className="setting-name">Downloaded neural voices</div>
              <div className="setting-desc">Click × to free the disk space</div>
            </div>
          </div>
          <div className="model-chips">
            {piper.voices.map((id) => (
              <span
                key={id}
                className={`model-chip${settings.ttsVoice === `${id}.onnx` ? " active" : ""}`}
              >
                {piperLabel(id)}
                <button
                  type="button"
                  aria-label={`Remove ${id}`}
                  disabled={!!dl}
                  onClick={() => void removePiperVoice(id)}
                >
                  <i className="fa-solid fa-xmark" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
