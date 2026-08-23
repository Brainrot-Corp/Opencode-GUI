import { getCurrentWindow } from "@tauri-apps/api/window";
import { playSound } from "../lib/sounds";

export default function Titlebar({
  pinned,
  onTogglePin,
  onOpenSettings,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenSettings?: () => void;
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
        <button className="icon-btn" title="Settings" onClick={() => onOpenSettings?.()}>
          <i className="fa-solid fa-gear" />
        </button>
        <button
          className={`icon-btn${pinned ? " on" : ""}`}
          title={pinned ? "Unpin (always on top)" : "Pin to top (always on top)"}
          aria-pressed={pinned ?? false}
          onClick={() => onTogglePin?.()}
        >
          <i className={`fa-solid fa-thumbtack${pinned ? " fa-rotate-45" : ""}`} />
        </button>
        <span className="ctrl-sep" />
        <button
          className="icon-btn"
          title="Hide to tray"
          onClick={() => {
            playSound("hide");
            getCurrentWindow().hide();
          }}
        >
          <i className="fa-solid fa-minus" />
        </button>
        <button
          className="icon-btn"
          title="Maximize / restore"
          onClick={() => {
            playSound("maximize");
            getCurrentWindow().toggleMaximize();
          }}
        >
          <i className="fa-regular fa-square" />
        </button>
        <button
          className="icon-btn close"
          title="Close"
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
