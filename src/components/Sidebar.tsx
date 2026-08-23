import { useState } from "react";
import type { Session } from "@opencode-ai/sdk/client";
import { playSound } from "../lib/sounds";
import FileTree from "./FileTree";
import "../styles/sidebar.css";

export default function Sidebar({
  sessions,
  activeId,
  busyIds,
  collapsed,
  loading,
  resizing,
  onToggle,
  onStartResize,
  onNew,
  onOpen,
  onDelete,
}: {
  sessions: Session[];
  activeId: string;
  busyIds?: Set<string>;
  width: number;
  collapsed: boolean;
  loading?: boolean;
  resizing?: boolean;
  onToggle: () => void;
  onStartResize: (e: React.MouseEvent) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState(() =>
    localStorage.getItem("oc.sb.tab") === "files" ? "files" : "chats",
  );
  const switchTab = (t: "chats" | "files") => {
    if (t === tab) return;
    playSound("click");
    setTab(t);
    localStorage.setItem("oc.sb.tab", t);
  };

  return (
    <>
      <aside
        className={`sidebar${collapsed ? " collapsed" : ""}${resizing ? " resizing" : ""}`}
      >
        {collapsed ? (
          <button
            className="icon-btn sb-expand"
            data-tip="Show session history"
            onClick={() => {
              playSound("expand");
              onToggle();
            }}
          >
            <i className="fa-solid fa-angles-right" />
          </button>
        ) : (
          <>
            <div className="sb-scroll">
              <div className="sb-head">
                <div className="sb-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={tab === "chats"}
                    className={tab === "chats" ? "active" : ""}
                    onClick={() => switchTab("chats")}
                  >
                    <i className="fa-solid fa-comments" />
                    Chats
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "files"}
                    className={tab === "files" ? "active" : ""}
                    onClick={() => switchTab("files")}
                  >
                    <i className="fa-solid fa-folder-tree" />
                    Files
                  </button>
                </div>
                <button
                  className="icon-btn sb-toggle"
                  data-tip="Hide panel"
                  onClick={() => {
                    playSound("collapse");
                    onToggle();
                  }}
                >
                  <i className="fa-solid fa-angles-left" />
                </button>
              </div>
              {tab === "chats" && (
                <button className="new-chat" onClick={onNew}>
                  <i className="fa-solid fa-plus" />
                  New chat
                </button>
              )}
              {loading && sessions.length === 0 ? (
                <>
                  <div className="skel-row" />
                  <div className="skel-row" style={{ animationDelay: "0.15s" }} />
                  <div className="skel-row" style={{ animationDelay: "0.3s" }} />
                  <div className="skel-row" style={{ animationDelay: "0.45s" }} />
                  <div className="skel-row" style={{ animationDelay: "0.6s" }} />
                </>
              ) : tab === "files" ? (
                <FileTree />
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className={`session-row ${s.id === activeId ? "active" : ""}`}>
                    <button
                      className="session-item"
                      onClick={() => onOpen(s.id)}
                      data-tip={s.title || s.id}
                    >
                      {s.title || "New session"}
                    </button>
                    {busyIds?.has(s.id) && <span className="row-busy" />}
                    <button className="del" data-tip="Delete session" onClick={() => onDelete(s.id)}>
                      <i className="fa-solid fa-xmark" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="sb-resize" data-tip="Drag to resize" onMouseDown={onStartResize} />
          </>
        )}
      </aside>
    </>
  );
}
