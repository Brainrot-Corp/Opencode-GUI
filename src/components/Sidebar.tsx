import type { Session } from "@opencode-ai/sdk/client";

export default function Sidebar({
  sessions,
  activeId,
  onNew,
  onOpen,
  onDelete,
}: {
  sessions: Session[];
  activeId: string;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <button className="new-chat" onClick={onNew}>
        + New chat
      </button>
      {sessions.map((s) => (
        <div key={s.id} className={`session-row ${s.id === activeId ? "active" : ""}`}>
          <button className="session-item" onClick={() => onOpen(s.id)} title={s.title || s.id}>
            {s.title || "New session"}
          </button>
          <button className="del" title="Delete session" onClick={() => onDelete(s.id)}>
            ×
          </button>
        </div>
      ))}
    </aside>
  );
}
