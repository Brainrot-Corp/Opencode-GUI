import type { SoundPrefs } from "../lib/sounds";

// Sounds settings — master volume + on/off toggles per UI sound
export default function SoundsSettings({
  sounds,
  updateSounds,
}: {
  sounds: SoundPrefs;
  updateSounds: (patch: Partial<SoundPrefs>) => void;
}) {
  return (
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
          value={sounds.volume}
          data-tip={`Master volume ${Math.round(sounds.volume * 100)}%`}
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
          className={`sound-row${sounds[key] ? " on" : ""}`}
          onClick={() => updateSounds({ [key]: !sounds[key] })}
          aria-pressed={sounds[key]}
        >
          <i className={`fa-solid ${icon}`} />
          <span>{name}</span>
          <span className={`pill${sounds[key] ? " on" : ""}`}>
            {sounds[key] ? "On" : "Off"}
          </span>
        </button>
      ))}
    </div>
  );
}
