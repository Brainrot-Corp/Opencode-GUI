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
import "../styles/settings.css";

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
  commands,
  pluginDocs,
  upd: updProp,
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
  // live command registry — Info dialog's Commands tab
  commands?: CmdEntry[];
  // plugin documentation rows for the Info dialog
  pluginDocs?: { name: string; info: NonNullable<import("../lib/plugins").PluginExt["info"]> }[];
  upd?: ReturnType<typeof useUpdaterInternal>;
}) {
  // custom themes have no stored color entry yet — cyan's shared base is the
  // starting point until the user overrides it
  const cs = (colorsFor?.(settings.theme) ?? settings.colors.cyan)[settings.mode];
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // first-launch setup can be replayed from here any time
  const [wizOpen, setWizOpen] = useState(false);
  // clean state: two-click confirm, then wipe voice installs + every oc.*
  // preference and reload into the first-launch wizard
  const [confirmClean, setConfirmClean] = useState(false);
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

  const [debugLocalPath, setDebugLocalPath] = useState("");
  const [debugLocalErr, setDebugLocalErr] = useState("");
  const [debugLocalBusy, setDebugLocalBusy] = useState(false);
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
          <h2>Settings</h2>
          <div className="color-controls">
            <button className="icon-btn" data-tip="Run setup again" onClick={() => setWizOpen(true)}>
              <i className="fa-solid fa-wand-magic-sparkles" />
            </button>
            <button className="icon-btn" data-tip="Voice, commands & hotkeys" onClick={() => setInfoOpen(true)}>
              <i className="fa-solid fa-circle-info" />
            </button>
            <button className="icon-btn" data-tip="Close" onClick={onClose}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
        </div>

        <div className="settings-body">
          {/* ── Appearance ── most-tweaked first */}
          <section className="settings-section settings-section--appearance" aria-label="Appearance">
            <div className="settings-section-title">
              <i className="fa-solid fa-palette" /> Appearance
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

            <AppearanceSettings
              themes={themes}
              themeId={settings.theme}
              cs={cs}
              updateColors={updateColors}
              resetColors={resetColors}
            />
          </section>

          {/* ── Project & Models ── */}
          <section className="settings-section" aria-label="Project and models">
            <div className="settings-section-title">
              <i className="fa-solid fa-folder-open" /> Project &amp; Models
            </div>

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
                <button type="button" className="reset-btn" data-tip="Open workspace (Ctrl+O)" onClick={() => pickWorkspace()}>
                  <i className="fa-solid fa-folder" />
                  Browse…
                </button>
              </div>
            </div>

            <div className="setting-row drop git-model-row secondary-model-row">
              <div className="setting-info">
                <i className="fa-solid fa-layer-group setting-icon" />
                <div>
                  <div className="setting-name">Secondary model</div>
                  <div className="setting-desc">
                    Cheap model for secondary tasks — commit messages, debriefs &amp; long-answer summaries (over 30 words)
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
                  <div className="setting-name">Commit body</div>
                  <div className="setting-desc">AI commit messages include a bullet body</div>
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
          <section className="settings-section" aria-label="Window and system">
            <div className="settings-section-title">
              <i className="fa-solid fa-window-restore" /> Window &amp; System
            </div>

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
                <i className="fa-solid fa-window-restore setting-icon" />
                <div>
                  <div className="setting-name">Keep window size</div>
                  <div className="setting-desc">Don't reset window size when reopening from tray</div>
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
                  <div className="setting-name">Close button quits</div>
                  <div className="setting-desc">Clicking X exits the app instead of hiding to tray (hold Ctrl to invert)</div>
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
          <section className="settings-section" aria-label="Terminal">
            <div className="settings-section-title">
              <i className="fa-solid fa-terminal" /> Terminal
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-power-off setting-icon" />
                <div>
                  <div className="setting-name">Default shell</div>
                  <div className="setting-desc">New terminals use this shell · per-terminal picker in the dock</div>
                </div>
              </div>
              <button type="button" className="reset-btn" disabled={termLoading} onClick={refreshTerms} data-tip="Detect installed shells again">
                <i className={`fa-solid ${termLoading ? "fa-spinner fa-spin" : "fa-rotate"}`} /> Detect again
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
              <div className="mono-hint" style={{ padding: "0 12px 6px", opacity: 0.7 }}>No shells detected — check WSL/Windows Terminal install</div>
            )}

            <div className="setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px" }}>
              <div className="setting-info">
                <i className="fa-solid fa-plus setting-icon" />
                <div>
                  <div className="setting-name">Custom shell</div>
                  <div className="setting-desc">Add any executable on PATH or absolute path · shown in both pickers</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <input className="discord-in" style={{ flex: "1 1 90px", minWidth: 0 }} placeholder="Name (e.g. Nushell)" value={customName} onChange={(e) => setCustomName(e.target.value)} spellCheck={false} maxLength={80} />
                <input className="discord-in" style={{ flex: "2 1 160px", minWidth: 0 }} placeholder="Path (C:\tools\nu.exe or nu)" value={customPath} onChange={(e) => setCustomPath(e.target.value)} spellCheck={false} />
                <input className="discord-in" style={{ flex: "1 1 80px", minWidth: 0 }} placeholder="Args (optional)" value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} spellCheck={false} />
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
                  <i className="fa-solid fa-plus" /> Add
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
                        data-tip="Remove custom shell"
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
          <section className="settings-section" aria-label="Voice and sound">
            <div className="settings-section-title">
              <i className="fa-solid fa-headset" /> Voice &amp; Sound
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-headset setting-icon" />
                <div>
                  <div className="setting-name">Voice &amp; speech</div>
                  <div className="setting-desc">
                    Speech engine, hands-free dictation, neural voices &amp; spoken replies
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="reset-btn"
                data-tip="Open voice settings"
                onClick={() => setVoiceOpen(true)}
              >
                <i className="fa-solid fa-sliders" />
                Open
              </button>
            </div>

            <SoundsSettings sounds={settings.sounds} updateSounds={updateSounds} />
          </section>

          {/* ── Updates ── */}
          <section className="settings-section" aria-label="Updates">
            <div className="settings-section-title">
              <i className="fa-solid fa-arrows-rotate" /> Updates
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-arrows-rotate setting-icon" />
                <div>
                  <div className="setting-name">Updates</div>
                  <div className="setting-desc">
                    {upd.err ? (
                      <span className="upd-err">{upd.err}</span>
                    ) : upd.latest ? (
                      <>
                        Version {upd.latest.version} available ·{" "}
                        {upd.latest.notes.replace(/\s+/g, " ").slice(0, 90)}
                      </>
                    ) : upd.busy ? (
                      "Checking for releases…"
                    ) : upd.ver ? (
                      <>You're up to date · v{upd.ver}</>
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
                    {upd.downloading ? "Downloading…" : "Update & restart"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="reset-btn"
                    disabled={upd.busy}
                    onClick={() => void upd.check(true)}
                  >
                    <i className="fa-solid fa-magnifying-glass" />
                    Check
                  </button>
                )}
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-bell setting-icon" />
                <div>
                  <div className="setting-name">Update notifications</div>
                  <div className="setting-desc">Show a prompt on launch when a new version is available</div>
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
                  <div className="setting-name">Debug local build</div>
                  <div className="setting-desc">Folder containing opencode-gui.exe — stages it and restarts (tests swap/relaunch without GitHub)</div>
                </div>
              </div>
              <div className="color-controls" style={{ display: "flex", gap: "6px", width: "100%" }}>
                <input
                  className="discord-in"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder="C:\path\to\folder"
                  value={debugLocalPath}
                  onChange={(e) => setDebugLocalPath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && debugLocalPath.trim() && !debugLocalBusy) void handleDebugLocal(); }}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="reset-btn"
                  disabled={!debugLocalPath.trim() || debugLocalBusy}
                  data-tip="Stage local opencode-gui.exe and restart"
                  onClick={() => void handleDebugLocal()}
                >
                  <i className={`fa-solid ${debugLocalBusy ? "fa-spinner fa-spin" : "fa-floppy-disk"}`} />
                  {debugLocalBusy ? "..." : "Use local"}
                </button>
              </div>
              {debugLocalErr && <div className="voice-err mono-hint" style={{ marginTop: "4px" }}>{debugLocalErr}</div>}
            </div>
          </section>

          {/* ── Danger Zone ── */}
          <section className="settings-section settings-section--danger" aria-label="Danger zone">
            <div className="settings-section-title">
              <i className="fa-solid fa-triangle-exclamation" /> Danger Zone
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <i className="fa-solid fa-broom setting-icon" />
                <div>
                  <div className="setting-name">Clean state</div>
                  <div className="setting-desc">
                    Uninstall all voice engines &amp; models and reset every
                    preference — next launch runs the setup again
                  </div>
                </div>
              </div>
              <button
                type="button"
                className={`reset-btn danger-btn${confirmClean ? " armed" : ""}`}
                onClick={() => void cleanState()}
              >
                <i className={`fa-solid ${confirmClean ? "fa-triangle-exclamation" : "fa-broom"}`} />
                {confirmClean ? "Really? Click again" : "Reset"}
              </button>
            </div>
          </section>

        </div>

        <div className="settings-foot">
          <span className="mono-hint">Alt+Space toggles the window anywhere · Ctrl+P pins on top · Ctrl+M mic · Ctrl+Shift+M mic anywhere</span>
        </div>
      </aside>
        {infoOpen && (
          <InfoDialog commands={commands ?? []} pluginDocs={pluginDocs} settings={settings} update={update} onClose={() => setInfoOpen(false)} />
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
