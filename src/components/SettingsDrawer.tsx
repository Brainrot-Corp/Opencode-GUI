import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ColorSet } from "../hooks/useSettings";
import { fetchTerminalProfiles, useTerminalProfiles } from "../hooks/useTerminalProfiles";
import { useUpdater as useUpdaterInternal } from "../hooks/useUpdater";
import type { ThemeMeta } from "../lib/themes";
import type { SoundPrefs } from "../lib/sounds";
import type { CmdEntry } from "../hooks/useOpencode";
import { applyWorkspace, pickWorkspace } from "../lib/workspace";
import { UI_SCALES } from "../lib/uiScale";
import ThemeSelect from "./ThemeSelect";
import SecondaryModelPicker from "./SecondaryModelPicker";
import TerminalShellPicker from "./TerminalShellPicker";
import VoicesDialog from "./VoicesDialog";
import Onboarding from "./Onboarding";
import AppearanceSettings from "./AppearanceSettings";
import SoundsSettings from "./SoundsSettings";
import InfoDialog from "./InfoDialog";
import type { ProviderGroup } from "../types";
import { useTranslation } from "../lib/i18n";
import "../styles/settings.css";

export default function SettingsDrawer({
  open,
  onClose,
  settings,
  update,
  updateSounds,
  updateColors,
  resetColors,
  resetThemes,
  themes,
  colorsFor,
  modes,
  effectiveMode,
  providers,
  commands,
  pluginDocs,
  plugins,
  upd: updProp,
}: {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateSounds: (patch: Partial<SoundPrefs>) => void;
  updateColors: (patch: Partial<ColorSet>) => void;
  resetColors: () => void;
  resetThemes?: () => void | Promise<void>;
  themes?: ThemeMeta[];
  colorsFor?: (theme: string) => Record<"dark" | "light", ColorSet>;
  // variations the active theme provides — Mode selector hidden when one
  modes?: ("dark" | "light")[];
  effectiveMode?: "dark" | "light";
  // live provider/model list from useOpencode — commit-message model picker
  providers?: ProviderGroup[];
  // live command registry — Info dialog's Commands tab
  commands?: CmdEntry[];
  // plugin documentation rows for the Info dialog
  pluginDocs?: { name: string; info: NonNullable<import("../lib/plugins").PluginExt["info"]> }[];
  plugins?: import("../lib/plugins").LoadedPlugin[];
  upd?: ReturnType<typeof useUpdaterInternal>;
}) {
  // custom themes have no stored color entry yet — cyan's shared base is the
  // starting point until the user overrides it. Prefer effectiveMode when the
  // theme locks to a single variation so the sliders match the actual CSS.
  const { t } = useTranslation();
  const displayMode = effectiveMode ?? settings.mode;
  const cs = (colorsFor?.(settings.theme) ?? settings.colors.cyan)[displayMode];
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // first-launch setup can be replayed from here any time
  const [wizOpen, setWizOpen] = useState(false);
  // clean state: two-click confirm, then wipe voice installs + every oc.*
  // preference and reload into the first-launch wizard
  const [confirmClean, setConfirmClean] = useState(false);
  const [confirmThemes, setConfirmThemes] = useState(false);
  const upd = updProp ?? useUpdaterInternal();

  // terminal discovery — shared global cache (probes + WSL + WT via Rust)
  const { profiles: termProfiles, loading: termLoading, error: termErr } = useTerminalProfiles();
  const [customName, setCustomName] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const refreshTerms = () => void fetchTerminalProfiles(true).catch(() => {});
  useEffect(() => {
    if (!open) return;
    if (termProfiles.length) return;
    void fetchTerminalProfiles().catch(() => {});
  }, [open, termProfiles.length]);

  const [debugLocalPath, setDebugLocalPath] = useState(() => {
    try { return localStorage.getItem("oc.debugLocalPath") ?? ""; } catch { return ""; }
  });
  const [debugLocalErr, setDebugLocalErr] = useState("");
  const [debugLocalBusy, setDebugLocalBusy] = useState(false);
  useEffect(() => { try { localStorage.setItem("oc.debugLocalPath", debugLocalPath); } catch {} }, [debugLocalPath]);
  async function handleDebugLocal() {
    const folder = debugLocalPath.trim();
    if (!folder) return;
    setDebugLocalErr("");
    setDebugLocalBusy(true);
    try {
      await invoke("update_stage_local", { folder, version: "debug-local" });
      await invoke("update_install", {});
    } catch (e) {
      setDebugLocalErr(String(e));
      setDebugLocalBusy(false);
    }
  }

  async function cleanState() {
    if (!confirmClean) {
      setConfirmClean(true);
      setTimeout(() => setConfirmClean(false), 4000);
      return;
    }
    await invoke("voice_remove_all").catch(() => {});
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("oc.")) localStorage.removeItem(k);
    }
    window.location.reload();
  }

  useEffect(() => {
    if (!open) return;
    invoke<boolean>("autostart_is_enabled")
      .then(setAutoLaunch)
      .catch(() => setAutoLaunch(false));
  }, [open]);

  // Escape closes the drawer — the global shortcuts hook stands its double-
  // Escape stop gesture down while .drawer-scrim.open matches, so this
  // surface is expected to own the key. Nested overlays (shared Dialog shell,
  // portaled menus, permission bar) keep their own Escape, so yield whenever
  // one of those is mounted
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      if (document.querySelector(".dlg-scrim, .cmd-menu, .model-menu, .permission-bar"))
        return;
      onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);

  async function toggleAutoLaunch() {
    try {
      if (autoLaunch) {
        await invoke("autostart_disable");
        setAutoLaunch(false);
      } else {
        await invoke("autostart_enable");
        // verify it actually stuck — registry writes can be virtualized
        const ok = await invoke<boolean>("autostart_is_enabled").catch(() => true);
        setAutoLaunch(ok);
      }
    } catch (e) {
      // surface error in console and keep toggle in sync with reality
      try { console.error("[autostart]", e); } catch {}
      const cur = await invoke<boolean>("autostart_is_enabled").catch(() => false);
      setAutoLaunch(cur);
    }
  }

  const scales = UI_SCALES;

  return (
    <>
      <div className={`drawer-scrim${open ? " open" : ""}`} onClick={onClose} />
      <aside
        className={`settings-drawer${open ? " open" : ""}`}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-head">
          <h2>{t("settings.title")}</h2>
          <div className="color-controls">
            <button className="icon-btn" data-tip={t("settings.tip.runSetup")} onClick={() => setWizOpen(true)}>
              <i className="fa-solid fa-wand-magic-sparkles" />
            </button>
            <button className="icon-btn" data-tip={t("settings.tip.info")} onClick={() => setInfoOpen(true)}>
              <i className="fa-solid fa-circle-info" />
            </button>
            <button className="icon-btn" data-tip={t("settings.tip.close")} onClick={onClose}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
        </div>

        <div className="settings-body">
          {/* ── Appearance ── most-tweaked first */}
          <section className="settings-section settings-section--appearance" aria-label={t("settings.appearance.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-palette" /> {t("settings.appearance.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-circle-half-stroke setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.appearance.theme.name")}</div>
                  <div className="setting-desc">{t("settings.appearance.theme.desc")}</div>
                </div>
              </div>
              <div className="color-controls">
                <button
                  type="button"
                  className="reset-btn"
                  data-tip={t("settings.appearance.theme.openConfig")}
                  onClick={() => invoke("reveal_config_dir").catch(() => {})}
                >
                  <i className="fa-solid fa-folder-tree" />
                </button>
                <ThemeSelect
                  themes={themes ?? []}
                  variant="drawer"
                  value={settings.theme}
                  onChange={(v) => update({ theme: v })}
                />
              </div>
            </div>
            {resetThemes && (
              <div style={{ padding: "0 12px 8px", display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className={`reset-btn${confirmThemes ? " danger-btn armed" : ""}`}
                  data-tip={t("settings.appearance.theme.reset")}
                  onClick={() => {
                    if (!confirmThemes) {
                      setConfirmThemes(true);
                      setTimeout(() => setConfirmThemes(false), 4000);
                      return;
                    }
                    setConfirmThemes(false);
                    void resetThemes();
                  }}
                >
                  <i className={`fa-solid ${confirmThemes ? "fa-triangle-exclamation" : "fa-rotate-left"}`} />
                  {confirmThemes ? t("settings.appearance.theme.resetConfirm") : t("settings.appearance.theme.reset")}
                </button>
              </div>
            )}

            {(!modes || modes.length > 1) && (
              <>
                <div className="setting-row">
                  <div className="setting-info">
                    <i className="fa-solid fa-circle-half-stroke setting-icon" />
                    <div>
                      <div className="setting-name">{t("settings.appearance.mode.name")}</div>
                      <div className="setting-desc">{t("settings.appearance.mode.desc")}</div>
                    </div>
                  </div>
                </div>
                <div className="seg-row" role="radiogroup" aria-label={t("settings.appearance.mode.name")}>
                  {(modes ?? (["dark", "light"] as const)).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={effectiveMode === m}
                      className={`seg${effectiveMode === m ? " on" : ""}`}
                      onClick={() => update({ mode: m })}
                    >
                      {m === "dark" ? t("settings.appearance.mode.dark") : t("settings.appearance.mode.light")}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-magnifying-glass-plus setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.appearance.scale.name")}</div>
                  <div className="setting-desc">{t("settings.appearance.scale.desc")}</div>
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

            <AppearanceSettings
              themes={themes}
              themeId={settings.theme}
              cs={cs}
              updateColors={updateColors}
              resetColors={resetColors}
            />
          </section>

          {/* ── Language ── */}
          <section className="settings-section" aria-label={t("settings.language.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-language" /> {t("settings.language.title")}
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-language setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.language.name")}</div>
                  <div className="setting-desc">{t("settings.language.desc")}</div>
                </div>
              </div>
            </div>
            <div className="seg-row" role="radiogroup" aria-label={t("settings.language.name")}>
              {(["en", "fr", "es"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={settings.language === l}
                  className={`seg${settings.language === l ? " on" : ""}`}
                  onClick={() => update({ language: l })}
                >
                  {l === "en" ? "English" : l === "fr" ? "Français" : "Español"}
                </button>
              ))}
            </div>
          </section>

          {/* ── Project & Models ── */}
          <section className="settings-section" aria-label={t("settings.project.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-folder-open" /> {t("settings.project.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-folder-open setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.project.workspace.name")}</div>
                  <div className="setting-desc mono-hint">
                    {settings.workspace || t("settings.project.workspace.home")}
                  </div>
                </div>
              </div>
              <div className="color-controls">
                {settings.workspace && (
                  <button
                    type="button"
                    className="reset-btn"
                    data-tip={t("settings.project.workspace.back")}
                    onClick={() => applyWorkspace("")}
                  >
                    <i className="fa-solid fa-rotate-left" />
                  </button>
                )}
                <button type="button" className="reset-btn" data-tip={t("settings.project.workspace.browseTip")} onClick={() => pickWorkspace()}>
                  <i className="fa-solid fa-folder" />
                  {t("settings.project.workspace.browse")}
                </button>
              </div>
            </div>

            <div className="setting-row drop git-model-row secondary-model-row">
              <div className="setting-info">
                <i className="fa-solid fa-layer-group setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.project.secondary.name")}</div>
                  <div className="setting-desc">
                    {t("settings.project.secondary.desc")}
                    {settings.secondaryModel && (
                      <span className="mono-hint"> · {settings.secondaryModel}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="color-controls">
                <SecondaryModelPicker
                  value={settings.secondaryModel}
                  onChange={(v) => update({ secondaryModel: v })}
                  providers={providers}
                />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-align-left setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.project.commitBody.name")}</div>
                  <div className="setting-desc">{t("settings.project.commitBody.desc")}</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle${settings.commitBody ? " on" : ""}`}
                aria-pressed={settings.commitBody}
                onClick={() => update({ commitBody: !settings.commitBody })}
              >
                <span className="knob" />
              </button>
            </div>
          </section>

          {/* ── Window & System ── */}
          <section className="settings-section" aria-label={t("settings.window.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-window-restore" /> {t("settings.window.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-rocket setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.window.launch.name")}</div>
                  <div className="setting-desc">{t("settings.window.launch.desc")}</div>
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
                  <div className="setting-name">{t("settings.window.alwaysOnTop.name")}</div>
                  <div className="setting-desc">{t("settings.window.alwaysOnTop.desc")}</div>
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
                <i className="fa-solid fa-window-restore setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.window.keepSize.name")}</div>
                  <div className="setting-desc">{t("settings.window.keepSize.desc")}</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle${settings.keepWindowSize ? " on" : ""}`}
                aria-pressed={settings.keepWindowSize}
                onClick={() => update({ keepWindowSize: !settings.keepWindowSize })}
              >
                <span className="knob" />
              </button>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-power-off setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.window.closeOnX.name")}</div>
                  <div className="setting-desc">{t("settings.window.closeOnX.desc")}</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle${settings.closeOnX ? " on" : ""}`}
                aria-pressed={settings.closeOnX}
                onClick={() => update({ closeOnX: !settings.closeOnX })}
              >
                <span className="knob" />
              </button>
            </div>
          </section>

          {/* ── Terminal ── */}
          <section className="settings-section" aria-label={t("settings.terminal.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-terminal" /> {t("settings.terminal.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-power-off setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.terminal.defaultShell.name")}</div>
                  <div className="setting-desc">{t("settings.terminal.defaultShell.desc")}</div>
                </div>
              </div>
              <button type="button" className="reset-btn" disabled={termLoading} onClick={refreshTerms} data-tip={t("settings.terminal.detectAgainTip")}>
                <i className={`fa-solid ${termLoading ? "fa-spinner fa-spin" : "fa-rotate"}`} /> {t("settings.terminal.detectAgain")}
              </button>
            </div>
            <div className="setting-row drop" style={{ paddingTop: 0 }}>
              <TerminalShellPicker
                value={settings.terminal?.defaultProfileId ?? ""}
                onChange={(v) => update({ terminal: { ...settings.terminal, defaultProfileId: v || null } })}
                profiles={termProfiles}
                customShells={settings.terminal?.customShells ?? []}
              />
            </div>
            {termErr && <div className="voice-err mono-hint" style={{ padding: "0 12px 6px" }}>{termErr}</div>}
            {!termLoading && termProfiles.length === 0 && !termErr && (
              <div className="mono-hint" style={{ padding: "0 12px 6px", opacity: 0.7 }}>{t("settings.terminal.noShells")}</div>
            )}

            <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px" }}>
              <div className="setting-info">
                <i className="fa-solid fa-plus setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.terminal.customShell.title")}</div>
                  <div className="setting-desc">{t("settings.terminal.customShell.desc")}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <input className="discord-in" style={{ flex: "1 1 90px", minWidth: 0 }} placeholder={t("settings.terminal.customShell.namePlaceholder")} value={customName} onChange={(e) => setCustomName(e.target.value)} spellCheck={false} maxLength={80} />
                <input className="discord-in" style={{ flex: "2 1 160px", minWidth: 0 }} placeholder={t("settings.terminal.customShell.pathPlaceholder")} value={customPath} onChange={(e) => setCustomPath(e.target.value)} spellCheck={false} />
                <input className="discord-in" style={{ flex: "1 1 80px", minWidth: 0 }} placeholder={t("settings.terminal.customShell.argsPlaceholder")} value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} spellCheck={false} />
                <button
                  type="button"
                  className="reset-btn"
                  disabled={!customName.trim() || !customPath.trim()}
                  onClick={() => {
                    const name = customName.trim().slice(0, 80);
                    const path = customPath.trim().slice(0, 500);
                    const args = customArgs.trim().slice(0, 500);
                    if (!name || !path) return;
                    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    const next = [...(settings.terminal?.customShells ?? []), { id, name, path, args }];
                    update({ terminal: { ...settings.terminal, customShells: next } });
                    setCustomName(""); setCustomPath(""); setCustomArgs("");
                  }}
                >
                  <i className="fa-solid fa-plus" /> {t("settings.terminal.customShell.add")}
                </button>
              </div>
              {(settings.terminal?.customShells?.length ?? 0) > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                  {settings.terminal.customShells.map((c) => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 6px", background: "var(--inset-bg)", border: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: "11px" }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${c.name} — ${c.path} ${c.args}`}>{c.name} — {c.path}{c.args ? " " + c.args : ""}</span>
                      <button
                        type="button"
                        className="reset-btn"
                        style={{ padding: "2px 6px" }}
                        onClick={() => {
                          const next = settings.terminal.customShells.filter((x) => x.id !== c.id);
                          const def = settings.terminal.defaultProfileId === c.id ? null : settings.terminal.defaultProfileId;
                          update({ terminal: { ...settings.terminal, customShells: next, defaultProfileId: def } });
                        }}
                        data-tip={t("settings.terminal.customShell.removeTip")}
                      >
                        <i className="fa-solid fa-trash-can" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ── Voice & Sound ── */}
          <section className="settings-section" aria-label={t("settings.voice.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-headset" /> {t("settings.voice.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-headset setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.voice.voiceSpeech.name")}</div>
                  <div className="setting-desc">
                    {t("settings.voice.voiceSpeech.desc")}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="reset-btn"
                data-tip={t("settings.voice.voiceSpeech.openTip")}
                onClick={() => setVoiceOpen(true)}
              >
                <i className="fa-solid fa-sliders" />
                {t("settings.voice.voiceSpeech.open")}
              </button>
            </div>

            <SoundsSettings sounds={settings.sounds} updateSounds={updateSounds} />
          </section>

          {/* ── Updates ── */}
          <section className="settings-section" aria-label={t("settings.updates.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-arrows-rotate" /> {t("settings.updates.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-arrows-rotate setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.updates.name")}</div>
                  <div className="setting-desc">
                    {upd.err ? (
                      <span className="upd-err">{upd.err}</span>
                    ) : upd.latest ? (
                      <>{t("settings.updates.available", { version: upd.latest.version, notes: upd.latest.notes.replace(/\s+/g, " ").slice(0, 90) })}</>
                    ) : upd.busy ? (
                      t("settings.updates.checking")
                    ) : upd.ver ? (
                      <>{t("settings.updates.upToDate", { version: upd.ver })}</>
                    ) : (
                      "Check for new releases from GitHub"
                    )}
                  </div>
                </div>
              </div>
              <div className="color-controls">
                {upd.latest ? (
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={upd.downloading}
                    onClick={() => void upd.install()}
                  >
                    <i className={`fa-solid ${upd.downloading ? "fa-spinner fa-spin" : "fa-download"}`} />
                    {upd.downloading ? t("settings.updates.downloading") : t("settings.updates.updateAndRestart")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={upd.busy}
                    onClick={() => void upd.check(true)}
                  >
                    <i className="fa-solid fa-magnifying-glass" />
                    {t("settings.updates.check")}
                  </button>
                )}
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-bell setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.updates.notifications.name")}</div>
                  <div className="setting-desc">{t("settings.updates.notifications.desc")}</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle${settings.updateNotifications ? " on" : ""}`}
                aria-pressed={settings.updateNotifications}
                onClick={() => {
                  const next = !settings.updateNotifications;
                  update({ updateNotifications: next });
                  if (next) localStorage.removeItem("oc.update.dismissed");
                }}
              >
                <span className="knob" />
              </button>
            </div>

            <div className="setting-row setting-row--muted" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px" }}>
              <div className="setting-info">
                <i className="fa-solid fa-folder-open setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.updates.debugLocal.title")}</div>
                  <div className="setting-desc">{t("settings.updates.debugLocal.desc")}</div>
                </div>
              </div>
              <div className="color-controls" style={{ display: "flex", gap: "6px", width: "100%" }}>
                <input
                  className="discord-in"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder={t("settings.updates.debugLocal.placeholder")}
                  value={debugLocalPath}
                  onChange={(e) => setDebugLocalPath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && debugLocalPath.trim() && !debugLocalBusy) void handleDebugLocal(); }}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="reset-btn"
                  disabled={!debugLocalPath.trim() || debugLocalBusy}
                  data-tip={t("settings.updates.debugLocal.useLocalTip")}
                  onClick={() => void handleDebugLocal()}
                >
                  <i className={`fa-solid ${debugLocalBusy ? "fa-spinner fa-spin" : "fa-floppy-disk"}`} />
                  {debugLocalBusy ? "..." : t("settings.updates.debugLocal.useLocal")}
                </button>
              </div>
              {debugLocalErr && <div className="voice-err mono-hint" style={{ marginTop: "4px" }}>{debugLocalErr}</div>}
            </div>
          </section>

          {/* ── Danger Zone ── */}
          <section className="settings-section settings-section--danger" aria-label={t("settings.danger.title")}>
            <div className="settings-section-title">
              <i className="fa-solid fa-triangle-exclamation" /> {t("settings.danger.title")}
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-broom setting-icon" />
                <div>
                  <div className="setting-name">{t("settings.danger.clean.name")}</div>
                  <div className="setting-desc">
                    {t("settings.danger.clean.desc")}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className={`reset-btn danger-btn${confirmClean ? " armed" : ""}`}
                onClick={() => void cleanState()}
              >
                <i className={`fa-solid ${confirmClean ? "fa-triangle-exclamation" : "fa-broom"}`} />
                {confirmClean ? t("settings.danger.clean.confirm") : t("settings.danger.clean.reset")}
              </button>
            </div>
          </section>

        </div>

        <div className="settings-foot">
          <span className="mono-hint">{t("settings.footHint")}</span>
        </div>
      </aside>
        {infoOpen && (
          <InfoDialog commands={commands ?? []} pluginDocs={pluginDocs} plugins={plugins} settings={settings} update={update} onClose={() => setInfoOpen(false)} />
        )}
        {wizOpen && (
          <Onboarding
            onClose={() => {
              localStorage.setItem("oc.onboarded", "1");
              setWizOpen(false);
            }}
            settings={settings}
            update={update}
            themes={themes ?? []}
            activeModes={modes ?? (["dark", "light"] as ("dark" | "light")[])}
            providers={providers}
          />
        )}
        <VoicesDialog
          open={voiceOpen}
          onClose={() => setVoiceOpen(false)}
          settings={settings}
          update={update}
        />
    </>
  );
}
