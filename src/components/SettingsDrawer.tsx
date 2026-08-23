import { useEffect, useState } from "react";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import type { AppColors, AppSettings } from "../hooks/useSettings";
import type { SoundPrefs } from "../lib/sounds";
import "../styles/settings.css";

export default function SettingsDrawer({
  open,
  onClose,
  settings,
  update,
  updateSounds,
  updateColors,
  resetColors,
}: {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateSounds: (patch: Partial<SoundPrefs>) => void;
  updateColors: (patch: Partial<AppColors>) => void;
  resetColors: () => void;
}) {
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
          <button className="icon-btn" title="Close" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div className="settings-body">
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
              <i className="fa-solid fa-palette setting-icon" />
              <span>Appearance</span>
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
                  value={settings.colors.base}
                  onChange={(e) => updateColors({ base: e.target.value })}
                  aria-label="Main background color"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={settings.colors.baseA}
                  onChange={(e) => updateColors({ baseA: Number(e.target.value) })}
                  aria-label="Main background transparency"
                />
                <span className="alpha-num">{Math.round(settings.colors.baseA * 100)}%</span>
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
                  value={settings.colors.surface}
                  onChange={(e) => updateColors({ surface: e.target.value })}
                  aria-label="Panel surface color"
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={settings.colors.surfaceA}
                  onChange={(e) => updateColors({ surfaceA: Number(e.target.value) })}
                  aria-label="Panel surface transparency"
                />
                <span className="alpha-num">{Math.round(settings.colors.surfaceA * 100)}%</span>
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
                title={`Master volume ${Math.round(settings.sounds.volume * 100)}%`}
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
          <span className="mono-hint">Alt+Space toggles the window anywhere</span>
        </div>
      </aside>
    </>
  );
}
