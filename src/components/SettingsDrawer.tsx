import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import type { AppSettings, ColorSet } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import type { SoundPrefs } from "../lib/sounds";
import { applyWorkspace, pickWorkspace } from "../lib/workspace";
import { splitModel } from "../lib/models";
import ThemeSelect from "./ThemeSelect";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import type { ProviderGroup } from "../types";
import "../styles/settings.css";

const WHISPER_BIN_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";
const MODEL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const VOICE_MODELS = [
  { id: "ggml-tiny.en.bin", label: "tiny.en · 78 MB · fastest, rougher" },
  { id: "ggml-base.en.bin", label: "base.en · 148 MB · recommended" },
  { id: "ggml-small.en.bin", label: "small.en · 488 MB · best accuracy" },
  { id: "ggml-base.bin", label: "base multilingual · 148 MB" },
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

// custom dropdown matching the model picker design language (native select
// popups can't be styled) — trigger + glass menu, closes on outside click
function PickerMenu({
  value,
  onPick,
  entries,
  label,
  disabled,
}: {
  value: string;
  onPick: (v: string) => void;
  entries: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [open]);

  return (
    <div className={`picker-menu${open ? " open" : ""}`} ref={ref}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <i className={`fa-solid fa-chevron-${open ? "up" : "down"}`} />
      </button>
      {open && (
        <div className="model-menu picker-drop" role="listbox">
          {entries.map((it) => (
            <button
              key={it.value}
              type="button"
              role="option"
              aria-selected={it.value === value}
              className={`model-opt${it.value === value ? " selected" : ""}`}
              onClick={() => {
                onPick(it.value);
                setOpen(false);
              }}
            >
              <span>{it.label}</span>
              {it.value === value && <i className="fa-solid fa-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsDrawer({
  open,
  onClose,
  settings,
  update,
  updateSounds,
  updateColors,
  resetColors,
  themes,
  colorsFor,
  modes,
  effectiveMode,
  providers,
}: {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateSounds: (patch: Partial<SoundPrefs>) => void;
  updateColors: (patch: Partial<ColorSet>) => void;
  resetColors: () => void;
  themes?: ThemeMeta[];
  colorsFor?: (theme: string) => Record<"dark" | "light", ColorSet>;
  // variations the active theme provides — Mode selector hidden when one
  modes?: ("dark" | "light")[];
  effectiveMode?: "dark" | "light";
  // live provider/model list from useOpencode — commit-message model picker
  providers?: ProviderGroup[];
}) {
  // custom themes have no stored color entry yet — cyan's shared base is the
  // starting point until the user overrides it
  const cs = (colorsFor?.(settings.theme) ?? settings.colors.cyan)[settings.mode];
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [voice, setVoice] = useState<{ bin: boolean; models: string[] } | null>(null);
  const [dl, setDl] = useState<{ label: string; pct: number } | null>(null);
  const [voiceErr, setVoiceErr] = useState("");
  // piper neural TTS: engine + downloaded voices (id list without .onnx)
  const [piper, setPiper] = useState<{ bin: boolean; voices: string[] } | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!open) return;
    isEnabled()
      .then(setAutoLaunch)
      .catch(() => setAutoLaunch(false));
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

  async function toggleAutoLaunch() {
    try {
      if (autoLaunch) {
        await disable();
        setAutoLaunch(false);
      } else {
        await enable();
        setAutoLaunch(true);
      }
    } catch {
      setAutoLaunch((v) => (v === null ? false : !v));
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

  const scales = [0.8, 0.9, 1, 1.1, 1.25];

  // secondary model picker — cheap model for commit messages, debriefs & long-answer summaries
  const [gmOpen, setGmOpen] = useState(false);
  const [gmHi, setGmHi] = useState(-1);
  const [gmQuery, setGmQuery] = useState("");
  const gmPretty = (sel: string) => {
    if (!sel) return "Off";
    const [pid, mid] = splitModel(sel);
    const g = providers?.find((x) => x.id === pid);
    const m = g?.models.find((x) => x.id === mid);
    return g && m ? `${g.label} · ${m.label}` : sel;
  };
  const gmEntries: ModelEntry[] = [
    { value: "", label: "Off — no secondary tasks" },
    ...(providers ?? []).flatMap((g) =>
      g.models.map((m) => ({ value: `${g.id}/${m.id}`, label: m.label, group: g.label })),
    ),
  ];
  const gmFiltered = (() => {
    const q = gmQuery.trim().toLowerCase();
    return q
      ? gmEntries.filter(
          (e2) =>
            e2.label.toLowerCase().includes(q) ||
            e2.value.toLowerCase().includes(q) ||
            (e2.group ?? "").toLowerCase().includes(q),
        )
      : gmEntries;
  })();

  return (
    <>
      <div className={`drawer-scrim${open ? " open" : ""}`} onClick={onClose} />
      <aside
        className={`settings-drawer${open ? " open" : ""}`}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" data-tip="Close" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="settings-body">
          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-folder-open setting-icon" />
              <div>
                <div className="setting-name">Workspace</div>
                <div className="setting-desc mono-hint">
                  {settings.workspace || "Home folder (no Git snapshots)"}
                </div>
              </div>
            </div>
            <div className="color-controls">
              {settings.workspace && (
                <button
                  type="button"
                  className="reset-btn"
                  data-tip="Back to home folder"
                  onClick={() => applyWorkspace("")}
                >
                  <i className="fa-solid fa-rotate-left" />
                </button>
              )}
              <button type="button" className="reset-btn" onClick={() => pickWorkspace()}>
                <i className="fa-solid fa-folder" />
                Browse…
              </button>
            </div>
          </div>

          <div className="setting-row git-model-row secondary-model-row">
            <div className="setting-info">
              <i className="fa-solid fa-layer-group setting-icon" />
              <div>
                <div className="setting-name">Secondary model</div>
                <div className="setting-desc">
                  Cheap model for secondary tasks — commit messages, debriefs &amp; long-answer summaries (over 30 words)
                </div>
              </div>
            </div>
            <div className="color-controls">
              <ModelMenu
                open={gmOpen}
                setOpen={setGmOpen}
                hi={gmHi}
                setHi={setGmHi}
                entries={gmFiltered}
                query={gmQuery}
                setQuery={setGmQuery}
                selected={settings.secondaryModel}
                label={providers?.length ? gmPretty(settings.secondaryModel) : "loading models…"}
                onPick={(v) => {
                  update({ secondaryModel: v });
                  setGmOpen(false);
                  setGmHi(-1);
                  setGmQuery("");
                }}
              />
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-circle-half-stroke setting-icon" />
              <div>
                <div className="setting-name">Theme</div>
                <div className="setting-desc">Interface color scheme</div>
              </div>
            </div>
            <div className="color-controls">
              <button
                type="button"
                className="reset-btn"
                data-tip="Open config folder"
                onClick={() => invoke("reveal_config_dir").catch(() => {})}
              >
                <i className="fa-solid fa-folder-tree" />
              </button>
              <ThemeSelect
                themes={themes ?? []}
                variant="drawer"
                value={settings.theme}
                onChange={(t) => update({ theme: t })}
              />
            </div>
          </div>

          {(!modes || modes.length > 1) && (
            <>
              <div className="setting-row">
                <div className="setting-info">
                  <i className="fa-solid fa-circle-half-stroke setting-icon" />
                  <div>
                    <div className="setting-name">Mode</div>
                    <div className="setting-desc">Dark or light variant of the theme</div>
                  </div>
                </div>
              </div>
              <div className="seg-row" role="radiogroup" aria-label="Mode">
                {(modes ?? (["dark", "light"] as const)).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={effectiveMode === m}
                    className={`seg${effectiveMode === m ? " on" : ""}`}
                    onClick={() => update({ mode: m })}
                  >
                    {m === "dark" ? "Dark" : "Light"}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-rocket setting-icon" />
              <div>
                <div className="setting-name">Launch on startup</div>
                <div className="setting-desc">Start OpenCode when Windows boots</div>
              </div>
            </div>
            <button
              type="button"
              className={`toggle${autoLaunch ? " on" : ""}`}
              disabled={autoLaunch === null}
              aria-pressed={autoLaunch ?? false}
              onClick={toggleAutoLaunch}
            >
              <span className="knob" />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-thumbtack setting-icon" />
              <div>
                <div className="setting-name">Always on top</div>
                <div className="setting-desc">Keep the window above all others</div>
              </div>
            </div>
            <button
              type="button"
              className={`toggle${settings.alwaysOnTop ? " on" : ""}`}
              aria-pressed={settings.alwaysOnTop}
              onClick={() => update({ alwaysOnTop: !settings.alwaysOnTop })}
            >
              <span className="knob" />
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-magnifying-glass-plus setting-icon" />
              <div>
                <div className="setting-name">UI scale</div>
                <div className="setting-desc">Zoom level of the whole interface</div>
              </div>
            </div>
          </div>
          <div className="seg-row" role="radiogroup" aria-label="UI scale">
            {scales.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={settings.uiScale === s}
                className={`seg${settings.uiScale === s ? " on" : ""}`}
                onClick={() => update({ uiScale: s })}
              >
                {Math.round(s * 100)}%
              </button>
            ))}
          </div>

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
                <i className="fa-solid fa-paper-plane setting-icon" />
                <div>
                  <div className="setting-name">Auto-send dictation</div>
                  <div className="setting-desc">Send spoken prompts without review</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle${settings.voice.autoSend ? " on" : ""}`}
                aria-pressed={settings.voice.autoSend}
                onClick={() =>
                  update({ voice: { ...settings.voice, autoSend: !settings.voice.autoSend } })
                }
              >
                <span className="knob" />
              </button>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-headset setting-icon" />
                <div>
                  <div className="setting-name">Hands-free dictation</div>
                  <div className="setting-desc">
                    Mic stays live; each pause becomes text for review — say
                    "envoyé" / "send it" to send
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
                    <i className="fa-solid fa-hourglass-half setting-icon" />
                    <div>
                      <div className="setting-name">Pause before transcription</div>
                      <div className="setting-desc">Silence length that ends a spoken phrase</div>
                    </div>
                  </div>
                  <div className="color-controls">
                    <input
                      type="range"
                      min={400}
                      max={4000}
                      step={100}
                      value={settings.voice.pauseMs}
                      aria-label="Pause before transcription"
                      onChange={(e) =>
                        update({ voice: { ...settings.voice, pauseMs: Number(e.target.value) } })
                      }
                    />
                    <span className="alpha-num">{(settings.voice.pauseMs / 1000).toFixed(1)}s</span>
                  </div>
                </div>

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

          <div className="sound-box">
            <div className="sound-box-head">
              <i className="fa-solid fa-palette setting-icon" />
              <span>Appearance</span>
              <span className="mono-hint">{themes?.find((t) => t.id === settings.theme)?.name}</span>
              <button type="button" className="reset-btn" onClick={resetColors}>
                <i className="fa-solid fa-rotate-left" />
                Reset
              </button>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-fill setting-icon" />
                <div>
                  <div className="setting-name">Main background</div>
                  <div className="setting-desc">Color and transparency behind everything</div>
                </div>
              </div>
              <div className="color-controls">
                <input
                  type="color"
                  value={cs.base}
                  onChange={(e) => updateColors({ base: e.target.value })}
                  aria-label="Main background color"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={cs.baseA}
                  onChange={(e) => updateColors({ baseA: Number(e.target.value) })}
                  aria-label="Main background transparency"
                />
                <span className="alpha-num">{Math.round(cs.baseA * 100)}%</span>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-layer-group setting-icon" />
                <div>
                  <div className="setting-name">Panel surface</div>
                  <div className="setting-desc">Chat history and input tint</div>
                </div>
              </div>
              <div className="color-controls">
                <input
                  type="color"
                  value={cs.surface}
                  onChange={(e) => updateColors({ surface: e.target.value })}
                  aria-label="Panel surface color"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={cs.surfaceA}
                  onChange={(e) => updateColors({ surfaceA: Number(e.target.value) })}
                  aria-label="Panel surface transparency"
                />
                <span className="alpha-num">{Math.round(cs.surfaceA * 100)}%</span>
              </div>
            </div>
          </div>

          <div className="sound-box">
            <div className="sound-box-head">
              <i className="fa-solid fa-volume-high setting-icon" />
              <span>Sounds</span>
              <input
                type="range"
                className="vol-slider"
                min={0}
                max={1}
                step={0.05}
                value={settings.sounds.volume}
                data-tip={`Master volume ${Math.round(settings.sounds.volume * 100)}%`}
                aria-label="Master volume"
                onChange={(e) => updateSounds({ volume: Number(e.target.value) })}
              />
            </div>
            {(
              [
                ["show", "fa-window-restore", "Show window"],
                ["hide", "fa-window-minimize", "Hide window"],
                ["maximize", "fa-up-right-and-down-left-from-center", "Maximize / restore"],
                ["close", "fa-xmark", "Close window"],
                ["send", "fa-paper-plane", "Message sent"],
                ["reply", "fa-bell", "Reply finished"],
                ["type", "fa-keyboard", "Typing"],
                ["resize", "fa-arrows-left-right", "Resizing"],
                ["panels", "fa-table-columns", "Panels & menus"],
                ["click", "fa-hand-pointer", "Button clicks"],
                ["working", "fa-wave-square", "Working pulse"],
              ] as const
            ).map(([key, icon, name]) => (
              <button
                key={key}
                type="button"
                className={`sound-row${settings.sounds[key] ? " on" : ""}`}
                onClick={() => updateSounds({ [key]: !settings.sounds[key] })}
                aria-pressed={settings.sounds[key]}
              >
                <i className={`fa-solid ${icon}`} />
                <span>{name}</span>
                <span className={`pill${settings.sounds[key] ? " on" : ""}`}>
                  {settings.sounds[key] ? "On" : "Off"}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-foot">
          <span className="mono-hint">Alt+Space toggles the window anywhere · Ctrl+P pins on top · Ctrl+M mic · Ctrl+Shift+M mic anywhere</span>
        </div>
      </aside>
    </>
  );
}
