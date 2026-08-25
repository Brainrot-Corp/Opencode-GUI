import { useEffect, useState } from "react";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import type { AppSettings, Mode } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import type { ProviderGroup } from "../types";
import { useVoiceInstall } from "../hooks/useVoiceInstall";
import { loadRecommended, DEFAULT_RECO, recoModelOk, type Reco } from "../lib/recommended";
import { obCopy } from "../lib/onboardingText";
import { splitModel } from "../lib/models";
import Dialog from "./Dialog";
import ThemeSelect from "./ThemeSelect";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import "../styles/onboarding.css";
import "../styles/settings.css";

const SCALES = [0.8, 0.9, 1, 1.1, 1.25];

// first-launch setup wizard — four short steps (hello / look / system / voice)
// with slide transitions. Closing by any means (finish, skip, Escape, scrim)
// lands in the parent's onClose which records oc.onboarded; the settings
// drawer can re-open it any time.
export default function Onboarding({
  onClose,
  settings,
  update,
  themes,
  activeModes,
  providers,
}: {
  onClose: () => void;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  themes: ThemeMeta[];
  activeModes: Mode[];
  providers?: ProviderGroup[];
}) {
  const t = obCopy();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const inst = useVoiceInstall(settings, update);
  const [reco, setReco] = useState<Reco>(DEFAULT_RECO);
  const [recoState, setRecoState] = useState<"idle" | "busy" | "done">("idle");
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  // set when the suggested secondary model fails the live availability check
  const [recoModelErr, setRecoModelErr] = useState(false);

  // remote recommendation spec — updates without shipping a build
  useEffect(() => {
    loadRecommended().then(setReco);
    inst.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    isEnabled()
      .then(setAutoLaunch)
      .catch(() => setAutoLaunch(false));
  }, []);

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

  function go(n: number) {
    setDir(n > step ? 1 : -1);
    setStep(n);
  }

  // recommended setup: whisper engine + model, then piper engine + voice.
  // each hook op skips what's already installed and resolves false on error
  async function runReco() {
    if (recoState === "busy") return;
    setRecoState("busy");
    const okW = await inst.installWhisper(reco.whisperModel, {
      binUrl: reco.whisperBinUrl,
      modelUrl: reco.whisperModelUrl,
    });
    const okP =
      okW &&
      (await inst.ensurePiper(reco.ttsVoice, {
        binUrl: reco.piperBinUrl,
        voiceUrl: reco.ttsVoiceUrl,
        cfgUrl: reco.ttsVoiceCfgUrl,
      }));
    setRecoState(okP ? "done" : "idle");
  }

  // secondary model picker state (ModelMenu owns only open/close chrome)
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
  const q = gmQuery.trim().toLowerCase();
  const gmFiltered = q
    ? gmEntries.filter(
        (e) =>
          e.label.toLowerCase().includes(q) ||
          e.value.toLowerCase().includes(q) ||
          (e.group ?? "").toLowerCase().includes(q),
      )
    : gmEntries;

  const speechReady = !!settings.secondaryModel && !!settings.ttsVoice;

  return (
    <Dialog title={t.title} top wide onClose={onClose}>
      <div className="ob-steps" role="tablist" aria-label="Setup steps">
        {t.steps.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={i === step}
            className={`ob-step-pill${i === step ? " on" : ""}${i < step ? " done" : ""}`}
            onClick={() => go(i)}
          >
            <i className={`fa-solid ${i < step ? "fa-check" : ["fa-hand-sparkles", "fa-palette", "fa-sliders", "fa-headset"][i]}`} />
            {label}
          </button>
        ))}
      </div>

      <div key={step} className={`ob-step ${dir === 1 ? "fwd" : "back"}`}>
        {step === 0 && (
          <>
            <div className="ob-hero">
              <span className="ob-hero-icon">
                <i className="fa-solid fa-comment-dots" />
              </span>
              <h2>{t.hello}</h2>
              <p>{t.body}</p>
            </div>
            <div className="ob-hint mono-hint">{t.hotkeys}</div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="ob-step-head">
              <h3>{t.lookTitle}</h3>
              <p>{t.lookDesc}</p>
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-circle-half-stroke setting-icon" />
                <div>
                  <div className="setting-name">Theme</div>
                  <div className="setting-desc">{t.themeDesc}</div>
                </div>
              </div>
              <ThemeSelect
                themes={themes}
                variant="drawer"
                value={settings.theme}
                onChange={(th) => update({ theme: th })}
              />
            </div>
            {activeModes.length > 1 && (
              <>
                <div className="setting-row">
                  <div className="setting-info">
                    <i className="fa-solid fa-circle-half-stroke setting-icon" />
                    <div>
                      <div className="setting-name">Mode</div>
                      <div className="setting-desc">{t.modeDesc}</div>
                    </div>
                  </div>
                </div>
                <div className="seg-row" role="radiogroup" aria-label="Mode">
                  {(["dark", "light"] as Mode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={settings.mode === m}
                      className={`seg${settings.mode === m ? " on" : ""}`}
                      onClick={() => update({ mode: m })}
                    >
                      {m === "dark" ? "Dark" : "Light"}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="ob-step-head">
              <h3>{t.systemTitle}</h3>
              <p>{t.systemDesc}</p>
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-rocket setting-icon" />
                <div>
                  <div className="setting-name">{t.startupName}</div>
                  <div className="setting-desc">{t.startupDesc}</div>
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
                <i className="fa-solid fa-magnifying-glass-plus setting-icon" />
                <div>
                  <div className="setting-name">{t.scaleName}</div>
                  <div className="setting-desc">{t.scaleDesc}</div>
                </div>
              </div>
            </div>
            <div className="seg-row" role="radiogroup" aria-label="UI scale">
              {SCALES.map((s) => (
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
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-layer-group setting-icon" />
                <div>
                  <div className="setting-name">{t.secondaryName}</div>
                  <div className="setting-desc">{t.secondaryDesc}</div>
                </div>
              </div>
              <ModelMenu
                open={gmOpen}
                setOpen={setGmOpen}
                hi={gmHi}
                setHi={setGmHi}
                entries={gmFiltered}
                query={gmQuery}
                setQuery={setGmQuery}
                selected={settings.secondaryModel}
                label={providers?.length ? gmPretty(settings.secondaryModel) : t.loadingModels}
                onPick={(v) => {
                  update({ secondaryModel: v });
                  setGmOpen(false);
                  setGmHi(-1);
                  setGmQuery("");
                }}
              />
            </div>
            {reco.secondaryModel && settings.secondaryModel !== reco.secondaryModel && (
              <div className="ob-reco-hint">
                <button
                  type="button"
                  className="linklike"
                  disabled={!providers?.length}
                  onClick={() => {
                    if (!recoModelOk(reco.secondaryModel, providers ?? [])) {
                      setRecoModelErr(true);
                      return;
                    }
                    setRecoModelErr(false);
                    update({ secondaryModel: reco.secondaryModel });
                  }}
                >
                  <i className="fa-solid fa-wand-magic-sparkles" />
                  {t.recoModel}: {gmPretty(reco.secondaryModel)}
                </button>
                {recoModelErr && <div className="voice-err">{t.badRecoModel}</div>}
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div className="ob-step-head">
              <h3>{t.voiceTitle}</h3>
              <p>{t.voiceDesc}</p>
            </div>

            <ToggleRow
              icon="fa-headset"
              name={t.handsFreeName}
              desc={t.handsFreeDesc}
              on={settings.voice.handsFree}
              onToggle={() =>
                update({ voice: { ...settings.voice, handsFree: !settings.voice.handsFree } })
              }
            />
            <ToggleRow
              icon="fa-language"
              name={t.multiName}
              desc={t.multiDesc}
              on={settings.voice.multilingual}
              onToggle={() =>
                update({ voice: { ...settings.voice, multilingual: !settings.voice.multilingual } })
              }
            />
            <ToggleRow
              icon="fa-volume-high"
              name={t.speakName}
              desc={t.speakDesc}
              on={settings.speakReplies}
              disabled={!speechReady}
              hint={
                !settings.secondaryModel
                  ? t.needModel
                  : !settings.ttsVoice
                    ? t.needVoice
                    : undefined
              }
              onToggle={() => update({ speakReplies: !settings.speakReplies })}
            />

            <div className="ob-reco">
              <button
                type="button"
                className="reset-btn ob-reco-btn"
                disabled={inst.busy || recoState === "done"}
                onClick={() => void runReco()}
              >
                <i className={`fa-solid ${recoState === "done" ? "fa-check" : "fa-wand-magic-sparkles"}`} />
                {recoState === "done" ? t.recoDone : t.recoButton}
              </button>
              <span className="mono-hint">
                {reco.note || t.recoNote}
                {" · "}
                {reco.ttsVoice}
              </span>
            </div>

            {recoState === "busy" && (
              <div className="dl-live" role="status">
                <i className="fa-solid fa-download setting-icon" />
                <span className="mono-hint">{t.recoBusy}</span>
                <span className="dl-bar">
                  <span className="dl-fill" />
                </span>
              </div>
            )}
            {inst.err && <div className="voice-err">{inst.err}</div>}
          </>
        )}
      </div>

      <div className="ob-foot">
        <button type="button" className="linklike" onClick={onClose}>
          {t.skip}
        </button>
        <div className="ob-foot-nav">
          {step > 0 && (
            <button type="button" className="reset-btn" onClick={() => go(step - 1)}>
              <i className="fa-solid fa-arrow-left" />
              {t.back}
            </button>
          )}
          <button
            type="button"
            className="reset-btn ob-next"
            onClick={() => (step < 3 ? go(step + 1) : onClose())}
          >
            {step < 3 ? t.next : t.finish}
            <i className={`fa-solid ${step < 3 ? "fa-arrow-right" : "fa-circle-check"}`} />
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ToggleRow({
  icon,
  name,
  desc,
  on,
  onToggle,
  disabled,
  hint,
}: {
  icon: string;
  name: string;
  desc: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="setting-row">
      <div className="setting-info">
        <i className={`fa-solid ${icon} setting-icon`} />
        <div>
          <div className="setting-name">{name}</div>
          <div className="setting-desc">{desc}</div>
          {hint && <div className="setting-desc ob-hint-warn">{hint}</div>}
        </div>
      </div>
      <button
        type="button"
        className={`toggle${on ? " on" : ""}`}
        aria-pressed={on}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="knob" />
      </button>
    </div>
  );
}
