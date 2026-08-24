import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import type { AppSettings, ColorSet } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import type { SoundPrefs } from "../lib/sounds";
import { applyWorkspace, pickWorkspace } from "../lib/workspace";
import { splitModel } from "../lib/models";
import ThemeSelect from "./ThemeSelect";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import VoiceSettings from "./VoiceSettings";
import AppearanceSettings from "./AppearanceSettings";
import SoundsSettings from "./SoundsSettings";
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

  useEffect(() => {
    if (!open) return;
    isEnabled()
      .then(setAutoLaunch)
      .catch(() => setAutoLaunch(false));
  }, [open]);

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

          <VoiceSettings open={open} settings={settings} update={update} />

          <AppearanceSettings
            themes={themes}
            themeId={settings.theme}
            cs={cs}
            updateColors={updateColors}
            resetColors={resetColors}
          />

          <SoundsSettings sounds={settings.sounds} updateSounds={updateSounds} />
        </div>

        <div className="settings-foot">
          <span className="mono-hint">Alt+Space toggles the window anywhere · Ctrl+P pins on top · Ctrl+M mic · Ctrl+Shift+M mic anywhere</span>
        </div>
      </aside>
    </>
  );
}
