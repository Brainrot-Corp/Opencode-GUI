import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "@opencode-ai/sdk/client";
import { playSound } from "../lib/sounds";
import FileTree from "./FileTree";
import GitPanel from "./GitPanel";
import "../styles/sidebar.css";

export default function Sidebar({
  sessions,
  activeId,
  busyIds,
  queueCounts,
  collapsed,
  loading,
  resizing,
  onToggle,
  onStartResize,
  onNew,
  onOpen,
  onDelete,
  onClearAll,
}: {
  sessions: Session[];
  activeId: string;
  busyIds?: Set<string>;
  queueCounts?: Record<string, number>;
  width: number;
  collapsed: boolean;
  loading?: boolean;
  resizing?: boolean;
  onToggle: () => void;
  onStartResize: (e: React.MouseEvent) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}) {
  const [tab, setTab] = useState(() =>
    localStorage.getItem("oc.sb.tab") === "files" ? "files" : "chats",
  );
  // two-step confirm for clear-all — first click arms, second fires
  const [clearArmed, setClearArmed] = useState(false);
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
        {...(collapsed
          ? ({ "data-tip": "Show session history", "data-tip-cursor": "" } as any)
          : {})}
        onClick={
          collapsed
            ? () => {
                playSound("expand");
                onToggle();
              }
            : undefined
        }
      >
        {collapsed ? (
          <>
            <button className="icon-btn sb-expand">
              <i className="fa-solid fa-angles-right" />
            </button>
            {/* GitPanel owns the oc:git listener that executes voice git
                commands ("stage all", "commit"…) — it must stay mounted even
                while the rail is collapsed or those events vanish silently */}
            <div style={{ display: "none" }}>
              <GitPanel />
            </div>
          </>
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
                <div className="new-chat-row">
                  <button className="new-chat" onClick={onNew}>
                    <i className="fa-solid fa-plus" />
                    New chat
                  </button>
                  {!!sessions.length && (
                    <button
                      className={`icon-btn sb-clear${clearArmed ? " armed" : ""}`}
                      data-tip={clearArmed ? "Click again to delete ALL sessions" : "Clear all sessions"}
                      aria-label="Clear all sessions"
                      onClick={() => {
                        if (clearArmed) {
                          setClearArmed(false);
                          onClearAll();
                        } else {
                          playSound("click");
                          setClearArmed(true);
                          window.setTimeout(() => setClearArmed(false), 3000);
                        }
                      }}
                    >
                      <i className={`fa-solid ${clearArmed ? "fa-triangle-exclamation" : "fa-trash-can"}`} />
                    </button>
                  )}
                </div>
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
                  <div
                    key={s.id}
                    className={`session-row ${s.id === activeId ? "active" : ""}`}
                    // middle-click anywhere on the row deletes instantly,
                    // no confirmation — preventDefault kills autoscroll
                    onMouseDown={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      onDelete(s.id);
                    }}
                  >
                    <button
                      className="session-item"
                      onClick={() => onOpen(s.id)}
                      data-tip={`${s.title || s.id} — middle-click to close`}
                    >
                      {s.title || "New session"}
                    </button>
                    {busyIds?.has(s.id) && <span className="row-busy" />}
                    {!!queueCounts?.[s.id] && (
                      <span className="row-queued" data-tip={`${queueCounts[s.id]} queued`}>
                        {queueCounts[s.id]}
                      </span>
                    )}
                    <button className="del" data-tip="Delete session" onClick={() => onDelete(s.id)}>
                      <i className="fa-solid fa-xmark" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <GitPanel />
            <div
              className="sb-resize"
              data-tip="Drag to resize"
              onMouseDown={onStartResize}
              onMouseEnter={() =>
                invoke("set_cursor", { shape: "col-resize" }).catch(() => {})
              }
              onMouseLeave={() => {
                // mid-drag the ChatPage drag handlers own the cursor
                if (!document.body.classList.contains("resizing"))
                  invoke("set_cursor").catch(() => {});
              }}
            />
          </>
        )}
      </aside>
    </>
  );
}
