import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../hooks/useSettings";
import PickerMenu from "./PickerMenu";
import Dialog from "./Dialog";
import {
  WHISPER_BIN_URL,
  MODEL_BASE,
  VOICE_MODELS,
  PIPER_BIN_URL,
  PIPER_LANGS,
  piperLabel,
  piperUrl,
  loadPiperCatalog,
} from "../lib/piper";

const SAMPLE_TEXT = "Hey, this is how I will read replies aloud.";

// centered glass dialog hosting everything speech-related: tab "Options"
// carries the whole former Settings Voice box (whisper engine, hands-free,
// spoken replies); tab "Voices" browses the full Piper catalog with search,
// one-click download-and-activate and inline previews
export default function VoicesDialog({
  open,
  onClose,
  settings,
  update,
}: {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [tab, setTab] = useState<"options" | "voices">("options");
  const [voice, setVoice] = useState<{ bin: boolean; models: string[] } | null>(null);
  const [dl, setDl] = useState<{ label: string; pct: number } | null>(null);
  const [voiceErr, setVoiceErr] = useState("");
  // piper neural TTS: engine + downloaded voices (id list without .onnx)
  const [piper, setPiper] = useState<{ bin: boolean; voices: string[] } | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  // full-catalog browser state
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    invoke<{ bin: boolean; models: string[] }>("voice_status")
      .then(setVoice)
      .catch(() => setVoice({ bin: false, models: [] }));
    invoke<{ bin: boolean; voices: string[] }>("tts_status")
      .then(setPiper)
      .catch(() => setPiper({ bin: false, voices: [] }));
  }, [open]);

  // catalog loads once per dialog session, lazily on first browse
  useEffect(() => {
    if (!open || tab !== "voices" || catLoading || catalog.length) return;
    setCatLoading(true);
    loadPiperCatalog()
      .then(setCatalog)
      .finally(() => setCatLoading(false));
  }, [open, tab, catLoading, catalog.length]);

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

  // plays a short sample through the given piper voice — used by the picker,
  // the preview button and browser rows; value is "<id>.onnx".
  // falls back to the first downloaded voice so the button never dead-ends
  function previewVoice(value: string) {
    const v = value || (piper?.voices.length ? `${piper.voices[0]}.onnx` : "");
    if (!v) {
      setVoiceErr("no neural voice yet — install Piper and download one in the Voices tab");
      return;
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
        a.play().catch((e) => setVoiceErr(`audio playback failed: ${e}`));
      })
      .catch((e) => setVoiceErr(String(e)));
  }

  // voice flow: picking an unavailable voice fetches whatever is missing
  // (engine first, then the onnx + json sidecar pair), then selects and
  // previews it
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
  // indicator label ("<id> · voice" / "<id> · config") so lists can mark it
  // live without extra state
  const dlVoiceId = (() => {
    const l = dl?.label ?? "";
    return l.endsWith("· voice") || l.endsWith("· config")
      ? l.slice(0, l.lastIndexOf(" · "))
      : "";
  })();

  // --- voices browser --------------------------------------------------------
  const q = query.trim().toLowerCase();
  const filtered = catalog.filter(
    (id) =>
      !q ||
      id.toLowerCase().includes(q) ||
      piperLabel(id).toLowerCase().includes(q),
  );

  if (!open) return null;

  return (
    <Dialog title="Voice & speech" top wide onClose={onClose}>
      <div className="dlg-tabs">
        {(
          [
            ["options", "Options"],
            ["voices", "Voices"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={`dlg-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {dl && (
        <div className="dl-live" role="status">
          <i className="fa-solid fa-download setting-icon" />
          <span className="mono-hint">{dl.label}</span>
          <span className="dl-bar">
            <span
              className={`dl-fill${dl.pct >= 0 ? " set" : ""}`}
              style={dl.pct >= 0 ? { width: `${dl.pct * 100}%` } : undefined}
            />
          </span>
        </div>
      )}

      {voiceErr && <div className="voice-err">{voiceErr}</div>}

      {tab === "voices" ? (
        <>
          <div className="browse-search">
            <div className="model-search-wrap">
              <i className="fa-solid fa-magnifying-glass" />
              <input
                className="model-search"
                type="text"
                placeholder={`Filter ${catalog.length || "..."} neural voices...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="browse-list">
            {filtered.length === 0 && (
              <div className="model-empty">{catLoading ? "Loading catalog..." : "No voices match"}</div>
            )}
            {filtered.map((id, i) => {
              const family = id.split("-")[0];
              const showGroup = i === 0 || filtered[i - 1].split("-")[0] !== family;
              const downloaded = (piper?.voices ?? []).includes(id);
              const active = settings.ttsVoice === `${id}.onnx`;
              const downloading = dlVoiceId === id;
              const suffix = active
                ? ""
                : downloading
                  ? " — downloading..."
                  : downloaded
                    ? ""
                    : " — not downloaded";
              return (
                <div key={id}>
                  {showGroup && (
                    <div className="model-group-label">
                      {PIPER_LANGS[family] ?? family}
                    </div>
                  )}
                  <div className={`browse-row${active ? " selected" : ""}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`model-opt${active ? " selected" : ""}`}
                      onClick={() => {
                        if (downloaded) {
                          update({ ttsVoice: `${id}.onnx` });
                          previewVoice(`${id}.onnx`);
                        } else {
                          void ensureVoice(id);
                        }
                      }}
                    >
                      <span>
                        {piperLabel(id)}
                        {suffix}
                      </span>
                      {active && <i className="fa-solid fa-check" />}
                    </button>
                    {downloaded && (
                      <button
                        type="button"
                        className="icon-btn"
                        data-tip="Preview"
                        aria-label={`Preview ${id}`}
                        disabled={!!dl}
                        onClick={() => previewVoice(`${id}.onnx`)}
                      >
                        <i className="fa-solid fa-play" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
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

          {!!voice?.models.length && (
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
          )}

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
                  listening pauses during playback. More voices live in the
                  Voices tab.
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
                entries={(piper?.voices ?? []).map((id) => ({
                  value: `${id}.onnx`,
                  label: piperLabel(id),
                }))}
                onPick={(file) => {
                  update({ ttsVoice: file });
                  previewVoice(file);
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

          {/* piper engine management — installs itself on demand */}
          {!!piper?.voices.length && (
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-wand-magic-sparkles setting-icon" />
                <div>
                  <div className="setting-name">Neural voices</div>
                  <div className="setting-desc">
                    Piper ready ·{" "}
                    <button type="button" className="linklike" onClick={() => setTab("voices")}>
                      manage in the Voices tab
                    </button>
                  </div>
                </div>
              </div>
              <div className="color-controls">
                <button type="button" className="reset-btn" onClick={() => setTab("voices")}>
                  <i className="fa-solid fa-globe" />
                  Browse…
                </button>
              </div>
            </div>
          )}

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
        </>
      )}
    </Dialog>
  );
}
