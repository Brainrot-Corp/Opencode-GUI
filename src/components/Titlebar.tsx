import { getCurrentWindow } from "@tauri-apps/api/window";
import { playSound } from "../lib/sounds";
import type { Mode, ThemeName } from "../hooks/useSettings";
import ThemeSelect from "./ThemeSelect";

export default function Titlebar({
  pinned,
  onTogglePin,
  onOpenSettings,
  theme,
  onThemeChange,
  mode,
  onModeChange,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenSettings?: () => void;
  theme?: ThemeName;
  onThemeChange?: (t: ThemeName) => void;
  mode?: Mode;
  onModeChange?: (m: Mode) => void;
}) {
  return (
    <header
      className="titlebar"
      data-tauri-drag-region
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
        <ThemeSelect value={theme ?? "cyan"} onChange={(t) => onThemeChange?.(t)} />
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
