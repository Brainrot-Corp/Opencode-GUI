import { getCurrentWindow } from "@tauri-apps/api/window";

export default function Titlebar() {
  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest(".win-controls")) return;
        getCurrentWindow().startDragging();
      }}
    >
      <div className="brand">
        <i />
        <span>OpenCode</span>
      </div>
      <div className="win-controls">
        <button className="icon-btn" title="Minimize" onClick={() => getCurrentWindow().minimize()}>
          <svg viewBox="0 0 24 24">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="Maximize / restore"
          onClick={() => getCurrentWindow().toggleMaximize()}
        >
          <svg viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
        <button className="icon-btn close" title="Close" onClick={() => getCurrentWindow().close()}>
          <svg viewBox="0 0 24 24">
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </div>
    </header>
  );
}
