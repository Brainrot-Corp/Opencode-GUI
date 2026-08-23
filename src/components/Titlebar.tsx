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
          <i className="fa-solid fa-minus" />
        </button>
        <button
          className="icon-btn"
          title="Maximize / restore"
          onClick={() => getCurrentWindow().toggleMaximize()}
        >
          <i className="fa-regular fa-square" />
        </button>
        <button className="icon-btn close" title="Close" onClick={() => getCurrentWindow().close()}>
          <i className="fa-solid fa-xmark" />
        </button>
      </div>
    </header>
  );
}
