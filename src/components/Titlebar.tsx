import { getCurrentWindow } from "@tauri-apps/api/window";

export default function Titlebar({
  showSidebarRestore,
  onSidebarRestore,
}: {
  showSidebarRestore?: boolean;
  onSidebarRestore?: () => void;
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
      <div className="tb-left">
        {showSidebarRestore && (
          <button
            className="icon-btn"
            title="Show session history"
            onClick={onSidebarRestore}
          >
            <i className="fa-solid fa-angles-right" />
          </button>
        )}
        <div className="brand">
          <i />
          <span>OpenCode</span>
        </div>
      </div>
      <div className="win-controls">
        <button
          className="icon-btn"
          title="Hide to tray"
          onClick={() => getCurrentWindow().hide()}
        >
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
