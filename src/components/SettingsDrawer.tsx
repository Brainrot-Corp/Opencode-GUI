import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import type { AppSettings, ColorSet } from "../hooks/useSettings";
import { useUpdater as useUpdaterInternal } from "../hooks/useUpdater";
import type { ThemeMeta } from "../lib/themes";
import type { SoundPrefs } from "../lib/sounds";
import type { CmdEntry } from "../hooks/useOpencode";
import type { PluginExt } from "../lib/plugins";
import { applyWorkspace, pickWorkspace } from "../lib/workspace";
import { splitModel } from "../lib/models";
import { UI_SCALES } from "../lib/uiScale";
import ThemeSelect from "./ThemeSelect";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import VoicesDialog from "./VoicesDialog";
import PluginsDialog from "./PluginsDialog";
import Onboarding from "./Onboarding";
import AppearanceSettings from "./AppearanceSettings";
import SoundsSettings from "./SoundsSettings";
import InfoDialog from "./InfoDialog";
import type { ProviderGroup } from "../types";
import type { LoadedPlugin } from "../lib/plugins";
import "../styles/settings.css";

export default function SettingsDrawer({
  open,
  onClose,
  settings,
  update,
  updatePlugin,
  updateSounds,
  updateColors,
  resetColors,
  themes,
  colorsFor,
  modes,
  effectiveMode,
  providers,
  commands,
  pluginSections,
  pluginDocs,
  plugins,
  onTogglePlugin,
  onRemoveDisabled,
  upd: updProp,
  onDebugUpdate,
}: {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  // patch the calling plugin's own config blob (curried per section below)
  updatePlugin: (id: string, patch: Record<string, unknown>) => void;
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
  // plugin-provided setting sections, in load order
  pluginSections?: PluginExt[];
  // plugin documentation rows for the Info dialog
  pluginDocs?: { name: string; info: NonNullable<PluginExt["info"]> }[];
  plugins?: LoadedPlugin[];
  onTogglePlugin?: (id: string, enabled: boolean) => void;
  onRemoveDisabled?: (id: string) => void;
  upd?: ReturnType<typeof useUpdaterInternal>;
  onDebugUpdate?: () => void;
}) {
  // custom themes have no stored color entry yet — cyan's shared base is the
  // starting point until the user overrides it
  const cs = (colorsFor?.(settings.theme) ?? settings.colors.cyan)[settings.mode];
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  // first-launch setup can be replayed from here any time
  const [wizOpen, setWizOpen] = useState(false);
  // clean state: two-click confirm, then wipe voice installs + every oc.*
  // preference and reload into the first-launch wizard
  const [confirmClean, setConfirmClean] = useState(false);
  const upd = updProp ?? useUpdaterInternal();

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
    isEnabled()
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

  const scales = UI_SCALES;

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
          <div className="color-controls">
            <button className="icon-btn" data-tip="Run setup again" onClick={() => setWizOpen(true)}>
              <i className="fa-solid fa-wand-magic-sparkles" />
            </button>
            <button className="icon-btn" data-tip="Plugins" onClick={() => setPluginsOpen(true)}>
              <i className="fa-solid fa-puzzle-piece" />
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

          {pluginSections?.map((p) => {
            const Section = p.Settings;
            return Section ? (
              <Section
                key={p.id}
                open={open}
                settings={settings}
                updatePlugin={(patch: Record<string, unknown>) => updatePlugin(p.id, patch)}
              />
            ) : null;
          })}

          <AppearanceSettings
            themes={themes}
            themeId={settings.theme}
            cs={cs}
            updateColors={updateColors}
            resetColors={resetColors}
          />

          <SoundsSettings sounds={settings.sounds} updateSounds={updateSounds} />
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

          <div className="setting-row">
            <div className="setting-info">
              <i className="fa-solid fa-bug setting-icon" />
              <div>
                <div className="setting-name">Debug update prompt</div>
                <div className="setting-desc">Preview the launch update dialog</div>
              </div>
            </div>
            <button type="button" className="reset-btn" onClick={() => onDebugUpdate?.()}>
              <i className="fa-solid fa-eye" />
              Show
            </button>
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

        </div>

        <div className="settings-foot">
          <span className="mono-hint">Alt+Space toggles the window anywhere · Ctrl+P pins on top · Ctrl+M mic · Ctrl+Shift+M mic anywhere</span>
        </div>
      </aside>
        {infoOpen && (
          <InfoDialog commands={commands ?? []} pluginDocs={pluginDocs} onClose={() => setInfoOpen(false)} />
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
        <PluginsDialog
          open={pluginsOpen}
          onClose={() => setPluginsOpen(false)}
          plugins={plugins ?? []}
          onToggle={(id, enabled) => onTogglePlugin?.(id, enabled)}
          onRemoved={(id) => onRemoveDisabled?.(id)}
        />
    </>
  );
}
