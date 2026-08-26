import type { ColorSet } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import InlineNumberInput from "./InlineNumberInput";

// Appearance settings — per-theme surface color + transparency overrides
export default function AppearanceSettings({
  themes,
  themeId,
  cs,
  updateColors,
  resetColors,
}: {
  themes?: ThemeMeta[];
  themeId: string;
  cs: ColorSet;
  updateColors: (patch: Partial<ColorSet>) => void;
  resetColors: () => void;
}) {
  return (
    <div className="sound-box">
      <div className="sound-box-head">
        <i className="fa-solid fa-palette setting-icon" />
        <span>Appearance</span>
        <span className="mono-hint">{themes?.find((t) => t.id === themeId)?.name}</span>
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
          <InlineNumberInput
            value={cs.baseA}
            min={0}
            max={1}
            step={0.02}
            suffix="%"
            ariaLabel="Main background transparency percent"
            onChange={(v) => updateColors({ baseA: v })}
          />
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
          <InlineNumberInput
            value={cs.surfaceA}
            min={0}
            max={1}
            step={0.02}
            suffix="%"
            ariaLabel="Panel surface transparency percent"
            onChange={(v) => updateColors({ surfaceA: v })}
          />
        </div>
      </div>
    </div>
  );
}
