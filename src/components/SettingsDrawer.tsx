import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import type { AppSettings, ColorSet } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import type { SoundPrefs } from "../lib/sounds";
import { applyWorkspace, pickWorkspace } from "../lib/workspace";
import ThemeSelect from "./ThemeSelect";
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
}) {
  // custom themes have no stored color entry yet — cyan's shared base is the
  // starting point until the user overrides it
  const cs = (colorsFor?.(settings.theme) ?? settings.colors.cyan)[settings.mode];
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [voice, setVoice] = useState<{ bin: boolean; models: string[] } | null>(null);
  const [dl, setDl] = useState<{ label: string; pct: number } | null>(null);
  const [voiceErr, setVoiceErr] = useState("");

  useEffect(() => {
    if (!open) return;
    isEnabled()
      .then(setAutoLaunch)
      .catch(() => setAutoLaunch(false));
    invoke<{ bin: boolean; models: string[] }>("voice_status")
      .then(setVoice)
      .catch(() => setVoice({ bin: false, models: [] }));
  }, [open]);

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

  const scales = [0.8, 0.9, 1, 1.1, 1.25];

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
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-circle-half-stroke setting-icon" />
                <div>
                  <div className="setting-name">Mode</div>
                  <div className="setting-desc">Dark or light variant of the theme</div>
                </div>
              </div>
              <div className="seg-row mode-seg" role="radiogroup" aria-label="Mode">
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
            </div>
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
              <span className="mono-hint">
                {dl
                  ? `${dl.label} ${dl.pct >= 0 ? `— ${Math.round(dl.pct * 100)}%` : "…"}`
                  : !voice?.bin
                    ? "not installed"
                    : voiceErr
                      ? "error — see below"
                      : "ready"}
              </span>
            </div>

            {voiceErr && <div className="setting-desc" style={{ padding: "0 12px 6px" }}>{voiceErr}</div>}

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
                <select
                  className="voice-select"
                  value={settings.voice.model}
                  aria-label="Whisper model"
                  onChange={(e) => update({ voice: { ...settings.voice, model: e.target.value } })}
                >
                  {VOICE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label + (voice?.models.includes(m.id) ? "" : " — not downloaded")}
                    </option>
                  ))}
                </select>
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
                  <div className="setting-desc">Read assistant answers aloud (code skipped)</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle${settings.speakReplies ? " on" : ""}`}
                aria-pressed={settings.speakReplies}
                onClick={() => update({ speakReplies: !settings.speakReplies })}
              >
                <span className="knob" />
              </button>
            </div>
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

            <div className="setting-row" style={{ borderTop: "1px solid var(--line)" }}>
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
          <span className="mono-hint">Alt+Space toggles the window anywhere · Ctrl+P pins on top</span>
        </div>
      </aside>
    </>
  );
}
