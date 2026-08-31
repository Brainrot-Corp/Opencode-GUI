import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../hooks/useSettings";
import { useVoiceInstall } from "../hooks/useVoiceInstall";
import PickerMenu from "./PickerMenu";
import Dialog from "./Dialog";
import InlineNumberInput from "./InlineNumberInput";
import { PIPER_LANGS, piperLabel, loadPiperCatalog, loadWhisperCatalog, wmGroup, type WhisperModel } from "../lib/piper";

// centered glass dialog hosting everything speech-related: tab "Options"
// carries the whole former Settings Voice box (whisper engine, sensitivity,
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
  const [tab, setTab] = useState<"options" | "voices" | "models">("options");
  // download/install pipeline lives in the shared hook (also feeds the
  // onboarding wizard)
  const inst = useVoiceInstall(settings, update);
  const { voice, piper } = inst;
  const dl = inst.dl;
  const voiceErr = inst.err;

  // full-catalog browser state
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [query, setQuery] = useState("");

  // GPU detection (NVIDIA for the cublas whisper engine)
  const [gpu, setGpu] = useState<{ nvidia: boolean; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    inst.refresh();
    invoke<{ nvidia: boolean; name: string }>("voice_gpu")
      .then(setGpu)
      .catch(() => setGpu(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // catalog loads once per dialog session, lazily on first browse
  useEffect(() => {
    if (!open || tab !== "voices" || catLoading || catalog.length) return;
    setCatLoading(true);
    loadPiperCatalog()
      .then(setCatalog)
      .finally(() => setCatLoading(false));
  }, [open, tab, catLoading, catalog.length]);

  // whisper model catalog — loads with the dialog so Options-tab picker and
  // chips get real sizes/labels too, not just the Models browser
  const [wModels, setWModels] = useState<WhisperModel[]>([]);
  const [wLoading, setWLoading] = useState(false);

  useEffect(() => {
    if (!open || wLoading || wModels.length) return;
    setWLoading(true);
    loadWhisperCatalog()
      .then(setWModels)
      .finally(() => setWLoading(false));
  }, [open, wLoading, wModels.length]);

  // the voice currently streaming in — derived from the shared download
  // indicator label ("<id> · voice" / "<id> · config") so lists can mark it
  // live without extra state
  const dlVoiceId = (() => {
    const l = dl?.label ?? "";
    return l.endsWith("· voice") || l.endsWith("· config")
      ? l.slice(0, l.lastIndexOf(" · "))
      : "";
  })();
  // whisper model downloads are labeled with the bare model id
  const dlModelId = dl?.label?.endsWith(".bin") ? dl.label : "";
  // pretty label for an installed model — catalog entry when fetched, bare
  // name otherwise (offline)
  const modelLabel = (id: string) =>
    wModels.find((m) => m.id === id)?.label ??
    id.replace("ggml-", "").replace(".bin", "");

  // --- voices browser --------------------------------------------------------
  const q = query.trim().toLowerCase();
  const filtered = catalog.filter(
    (id) =>
      !q ||
      id.toLowerCase().includes(q) ||
      piperLabel(id).toLowerCase().includes(q),
  );
  const wFiltered = wModels.filter(
    (m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
  );

  if (!open) return null;

  return (
    <Dialog title="Voice & speech" top wide onClose={onClose}>
      <div className="dlg-tabs">
        {(
          [
            ["options", "Options"],
            ["models", "Models"],
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
              const downloaded = (piper?.items ?? []).includes(id);
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
                          inst.previewVoice(`${id}.onnx`);
                        } else {
                          void inst.ensurePiper(id);
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
                        onClick={() => inst.previewVoice(`${id}.onnx`)}
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
      ) : tab === "models" ? (
        <>
          <div className="browse-search">
            <div className="model-search-wrap">
              <i className="fa-solid fa-magnifying-glass" />
              <input
                className="model-search"
                type="text"
                placeholder={`Filter ${wModels.length || "..."} whisper models...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="browse-list">
            {wFiltered.length === 0 && (
              <div className="model-empty">{wLoading ? "Loading catalog..." : "No models match"}</div>
            )}
            {wFiltered.map((m, i) => {
              const group = wmGroup(m.id);
              const showGroup = i === 0 || wmGroup(wFiltered[i - 1].id) !== group;
              const downloaded = (voice?.items ?? []).includes(m.id);
              const active = downloaded && settings.voice.model === m.id;
              const downloading = dlModelId === m.id;
              const suffix = active
                ? ""
                : downloading
                  ? " — downloading..."
                  : downloaded
                    ? ""
                    : " — not downloaded";
              return (
                <div key={m.id}>
                  {showGroup && (
                    <div className="model-group-label">
                      {group[0].toUpperCase() + group.slice(1)}
                    </div>
                  )}
                  <div className={`browse-row${active ? " selected" : ""}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`model-opt${active ? " selected" : ""}`}
                      onClick={() => {
                        if (downloaded) update({ voice: { ...settings.voice, model: m.id } });
                        else void inst.installWhisper(m.id);
                      }}
                    >
                      <span>
                        {m.label}
                        {suffix}
                      </span>
                      {active && <i className="fa-solid fa-check" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="setting-row drop">
            <div className="setting-info">
              <i className="fa-solid fa-microchip setting-icon" />
              <div>
                <div className="setting-name">Speech engine</div>
                <div className="setting-desc">
                  {voice?.bin ? (
                    <>
                      {`whisper.cpp ready · ${voice.items.length} model${voice.items.length === 1 ? "" : "s"} downloaded — `}
                      <button type="button" className="linklike" onClick={() => setTab("models")}>
                        browse all in the Models tab
                      </button>
                    </>
                  ) : (
                    "Local whisper.cpp — downloads once, runs offline"
                  )}
                </div>
              </div>
            </div>
            <div className="color-controls">
              {(!voice?.bin || !voice.items.includes(settings.voice.model)) && (
                <button
                  type="button"
                  className="reset-btn"
                  disabled={!!dl}
                  onClick={() => void inst.installWhisper()}
                >
                  <i className="fa-solid fa-download" />
                  {!voice?.bin ? "Install (~10 MB)" : "Download model"}
                </button>
              )}
              <PickerMenu
                value={settings.voice.model}
                disabled={!!dl}
                empty="No models downloaded"
                label={
                  voice?.items.includes(settings.voice.model)
                    ? modelLabel(settings.voice.model)
                    : "No models downloaded"
                }
                entries={(voice?.items ?? []).map((id) => ({
                  value: id,
                  label: modelLabel(id),
                }))}
                onPick={(v) => update({ voice: { ...settings.voice, model: v } })}
              />
            </div>
          </div>

          {!!voice?.items.length && (
            <div className="setting-row wrap">
              <div className="setting-info">
                <i className="fa-solid fa-database setting-icon" />
                <div>
                  <div className="setting-name">Downloaded models</div>
                  <div className="setting-desc">Click × to free the disk space</div>
                </div>
              </div>
              <div className="model-chips">
                {voice.items.map((m) => (
                  <span key={m} className={`model-chip${settings.voice.model === m ? " active" : ""}`}>
                    {modelLabel(m)}
                    <button
                      type="button"
                      aria-label={`Remove ${m}`}
                      disabled={!!dl}
                      onClick={() => void inst.removeModel(m)}
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
              <InlineNumberInput
                value={settings.voice.sens}
                min={0}
                max={1}
                step={0.05}
                suffix="%"
                ariaLabel="Microphone sensitivity percent"
                onChange={(v) => update({ voice: { ...settings.voice, sens: v } })}
              />
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-language setting-icon" />
              <div>
                <div className="setting-name">Multilingual commands</div>
                <div className="setting-desc">
                  Translates speech to English before matching — on a miss, the
                  native-language transcription gets one retry
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
              <i className="fa-solid fa-bolt setting-icon" />
              <div>
                <div className="setting-name">GPU transcription</div>
                <div className="setting-desc">
                  {!gpu
                    ? "Checking for an NVIDIA GPU…"
                    : gpu.nvidia
                      ? voice?.gpuBin
                        ? `${gpu.name} — CUDA 12.4 decode, automatic CPU fallback (needs driver ≥ 552)`
                        : `${gpu.name} detected — installs a CUDA engine next to the CPU one`
                      : "No NVIDIA GPU detected — the GPU engine needs one"}
                </div>
              </div>
            </div>
            <div className="color-controls">
              {!voice?.gpuBin ? (
                <button
                  type="button"
                  className="reset-btn"
                  disabled={!!dl || !gpu?.nvidia}
                  onClick={() => void inst.installWhisperGpu()}
                >
                  <i className="fa-solid fa-download" />
                  Install GPU engine (671 MB)
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={!!dl}
                    aria-label="Reinstall GPU engine"
                    onClick={() => void inst.installWhisperGpu(true)}
                  >
                    <i className="fa-solid fa-rotate" />
                    Reinstall
                  </button>
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={!!dl}
                    aria-label="Delete GPU engine"
                    onClick={() => void inst.removeGpuEngine()}
                  >
                    <i className="fa-solid fa-trash-can" />
                    Delete
                  </button>
                  <button
                    type="button"
                    className={`toggle${settings.voice.gpu ? " on" : ""}`}
                    aria-pressed={settings.voice.gpu}
                    onClick={() =>
                      update({ voice: { ...settings.voice, gpu: !settings.voice.gpu } })
                    }
                  >
                    <span className="knob" />
                  </button>
                </>
              )}
            </div>
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

          <div className="setting-row drop">
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
                empty="No voices downloaded"
                label={
                  settings.ttsVoice
                    ? piperLabel(settings.ttsVoice.replace(/\.onnx$/, ""))
                    : "Pick a voice…"
                }
                entries={(piper?.items ?? []).map((id) => ({
                  value: `${id}.onnx`,
                  label: piperLabel(id),
                }))}
                onPick={(file) => {
                  update({ ttsVoice: file });
                  inst.previewVoice(file);
                }}
              />
              <button
                type="button"
                className="reset-btn"
                data-tip="Preview voice"
                aria-label="Preview voice"
                disabled={!(settings.ttsVoice || piper?.items.length)}
                onClick={() => inst.previewVoice(settings.ttsVoice)}
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
              <InlineNumberInput
                value={settings.ttsVol}
                min={0}
                max={1}
                step={0.05}
                suffix="%"
                ariaLabel="Speech volume percent"
                onChange={(v) => {
                  update({ ttsVol: v });
                  window.dispatchEvent(new CustomEvent("oc:tts-vol", { detail: v }));
                }}
              />
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
              <InlineNumberInput
                value={settings.ttsSpeed}
                min={0.5}
                max={2}
                step={0.05}
                suffix="×"
                ariaLabel="Speech speed multiplier"
                onChange={(v) => update({ ttsSpeed: v })}
              />
            </div>
          </div>

          {/* piper engine management — installs itself on demand */}
          {!!piper?.items.length && (
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

          {!!piper?.items.length && (
            <div className="setting-row wrap">
              <div className="setting-info">
                <i className="fa-solid fa-database setting-icon" />
                <div>
                  <div className="setting-name">Downloaded neural voices</div>
                  <div className="setting-desc">Click × to free the disk space</div>
                </div>
              </div>
              <div className="model-chips">
                {piper.items.map((id) => (
                  <span
                    key={id}
                    className={`model-chip${settings.ttsVoice === `${id}.onnx` ? " active" : ""}`}
                  >
                    {piperLabel(id)}
                    <button
                      type="button"
                      aria-label={`Remove ${id}`}
                      disabled={!!dl}
                      onClick={() => void inst.removePiperVoice(id)}
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
