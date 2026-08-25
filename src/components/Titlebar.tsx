import { getCurrentWindow } from "@tauri-apps/api/window";
import { playSound } from "../lib/sounds";
import type { Mode } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import ThemeSelect from "./ThemeSelect";

export default function Titlebar({
  pinned,
  onTogglePin,
  onOpenSettings,
  themes,
  theme,
  onThemeChange,
  mode,
  onModeChange,
  modes,
  talking,
  debriefing,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenSettings?: () => void;
  themes?: ThemeMeta[];
  theme?: string;
  onThemeChange?: (t: string) => void;
  mode?: Mode;
  onModeChange?: (m: Mode) => void;
  // variations the active theme provides — hidden toggle when only one
  modes?: Mode[];
  // TTS queue draining / audio audible — show the speaking indicator
  talking?: boolean;
  debriefing?: boolean;
}) {
  return (
    <header
      className="titlebar"
      // no data-tauri-drag-region: Tauri's own region handler maximizes on
      // double-click — dragging is done manually below, dblclick is a no-op
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // buttons handle their own clicks; only bare titlebar drags the window
        if ((e.target as HTMLElement).closest("button")) return;
        getCurrentWindow().startDragging();
      }}
    >
      <div className="brand">
        <i />
        <span>OpenCode</span>
      </div>
      <div className="win-controls">
        {debriefing && (
          <span className="debrief-indicator" data-tip="Debrief in progress — preparing summary">
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
            <em>Debriefing</em>
            <i className="debrief-dot" aria-hidden="true" />
          </span>
        )}
        <ThemeSelect themes={themes ?? []} value={theme ?? "cyan"} onChange={(t) => onThemeChange?.(t)} />
        {(!modes || modes.length > 1) && (
          <button
            className="icon-btn"
            data-tip={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
            onClick={() => {
              playSound("click");
              onModeChange?.(mode === "light" ? "dark" : "light");
            }}
          >
            <i className={`fa-solid ${mode === "light" ? "fa-moon" : "fa-regular fa-sun"}`} />
          </button>
        )}
        {talking && (
          <button
            className="debrief-indicator speech-indicator"
            data-tip="Stop speech"
            aria-label="Stop speech"
            onClick={() => {
              playSound("click");
              window.dispatchEvent(new Event("oc:tts-stop"));
            }}
          >
            <i className="fa-solid fa-volume-high" aria-hidden="true" />
            <em>Speaking</em>
            <i className="debrief-dot" aria-hidden="true" />
          </button>
        )}
        <span className="ctrl-sep" />
        <button className="icon-btn" data-tip="Settings" onClick={() => onOpenSettings?.()}>
          <i className="fa-solid fa-gear" />
        </button>
        <button
          className={`icon-btn${pinned ? " on" : ""}`}
          data-tip={pinned ? "Unpin (always on top)" : "Pin to top (always on top)"}
          aria-pressed={pinned ?? false}
          onClick={() => onTogglePin?.()}
        >
          <i className={`fa-solid fa-thumbtack${pinned ? " fa-rotate-45" : ""}`} />
        </button>
        <span className="ctrl-sep" />
        <button
          className="icon-btn"
          data-tip="Hide to tray"
          onClick={() => {
            playSound("hide");
            getCurrentWindow().hide();
          }}
        >
          <i className="fa-solid fa-minus" />
        </button>
        <button
          className="icon-btn"
          data-tip="Maximize / restore"
          onClick={() => {
            playSound("maximize");
            getCurrentWindow().toggleMaximize();
          }}
        >
          <i className="fa-regular fa-square" />
        </button>
        <button
          className="icon-btn close"
          data-tip="Close"
          onClick={() => {
            playSound("close");
            window.setTimeout(() => getCurrentWindow().close(), 130);
          }}
        >
          <i className="fa-solid fa-xmark" />
        </button>
      </div>
    </header>
  );
}
