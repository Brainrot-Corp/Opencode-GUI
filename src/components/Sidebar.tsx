import type { Session } from "@opencode-ai/sdk/client";
import "../styles/sidebar.css";

export default function Sidebar({
  sessions,
  activeId,
  collapsed,
  onToggle,
  onStartResize,
  onNew,
  onOpen,
  onDelete,
}: {
  sessions: Session[];
  activeId: string;
  width: number;
  collapsed: boolean;
  onToggle: () => void;
  onStartResize: (e: React.MouseEvent) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
        {collapsed ? (
          <button className="icon-btn sb-expand" title="Show session history" onClick={onToggle}>
            <i className="fa-solid fa-angles-right" />
          </button>
        ) : (
          <>
            <div className="sb-scroll">
              <div className="sb-head">
                <button className="new-chat" onClick={onNew}>
                  <i className="fa-solid fa-plus" />
                  New chat
                </button>
                <button
                  className="icon-btn sb-toggle"
                  title="Hide session history"
                  onClick={onToggle}
                >
                  <i className="fa-solid fa-angles-left" />
                </button>
              </div>
              {sessions.map((s) => (
                <div key={s.id} className={`session-row ${s.id === activeId ? "active" : ""}`}>
                  <button className="session-item" onClick={() => onOpen(s.id)} title={s.title || s.id}>
                    {s.title || "New session"}
                  </button>
                  <button className="del" title="Delete session" onClick={() => onDelete(s.id)}>
                    <i className="fa-solid fa-xmark" />
                  </button>
                </div>
              ))}
            </div>
            <div className="sb-resize" title="Drag to resize" onMouseDown={onStartResize} />
          </>
        )}
      </aside>
    </>
  );
}
