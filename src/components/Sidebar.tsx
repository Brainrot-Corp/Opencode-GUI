import { useState } from "react";
import type { Session } from "@opencode-ai/sdk/client";
import { playSound } from "../lib/sounds";
import { useContextMenu } from "../hooks/useContextMenu";
import { clipboardWrite } from "../lib/clipboard";
import { opencode } from "../api";
import FileTree from "./FileTree";
import GitPanel from "./GitPanel";
import "../styles/sidebar.css";

export default function Sidebar({
  sessions,
  activeId,
  busyIds,
  compactingIds,
  attentionIds,
  attentionKinds,
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
  onRename,
  onDuplicate,
  onTogglePin,
  isPinned,
  sidebarExtras,
}: {
  sessions: Session[];
  activeId: string;
  busyIds?: Set<string>;
  compactingIds?: Set<string>;
  attentionIds?: Set<string>;
  attentionKinds?: Record<string, "permission" | "question" | "both">;
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
  onRename?: (id: string, title: string) => void;
  onDuplicate?: (id: string) => void;
  onTogglePin?: (id: string) => void;
  isPinned?: (id: string) => boolean;
  sidebarExtras?: React.ReactNode;
}) {
  const [tab, setTab] = useState(() =>
    localStorage.getItem("oc.sb.tab") === "files" ? "files" : "chats",
  );
  // two-step confirm for clear-all — first click arms, second fires
  const [clearArmed, setClearArmed] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const ctx = (() => { try { return useContextMenu(); } catch { return null; } })();
  const switchTab = (t: "chats" | "files") => {
    if (t === tab) return;
    playSound("click");
    setTab(t);
    localStorage.setItem("oc.sb.tab", t);
  };

  const startRename = (s: Session) => {
    setRenaming(s.id);
    setDraftTitle(s.title || "");
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`input[data-rename="${s.id}"]`);
      el?.focus(); el?.select();
    }, 0);
  };
  const commitRename = () => {
    if (!renaming) return;
    const t = draftTitle.trim();
    if (t) onRename?.(renaming, t);
    setRenaming(null);
  };

  return (
    <>
      <aside
        className={`sidebar${collapsed ? " collapsed" : ""}${resizing ? " resizing" : ""}`}
        {...(collapsed
          ? ({ "data-tip": "Show session history (Ctrl+B)", "data-tip-cursor": "" } as any)
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
            {!!attentionIds?.size && (
              <span
                className="sb-attention-badge"
                data-tip={`${attentionIds.size} session${attentionIds.size > 1 ? "s" : ""} need${attentionIds.size === 1 ? "s" : ""} your attention — click to show`}
                aria-label="Attention needed"
              >
                {attentionIds.size > 1 ? attentionIds.size : <i className="fa-solid fa-bell" />}
              </span>
            )}
            {/* keep sidebars mounted when collapsed so voice git + spotify poll don't die */}
            <div style={{ display: "none" }}>
              <GitPanel />
              {sidebarExtras}
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
                  data-tip="Hide panel (Ctrl+B)"
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
              {loading && sessions.length === 0 && (
                <>
                  <div className="skel-row" />
                  <div className="skel-row" style={{ animationDelay: "0.15s" }} />
                  <div className="skel-row" style={{ animationDelay: "0.3s" }} />
                  <div className="skel-row" style={{ animationDelay: "0.45s" }} />
                  <div className="skel-row" style={{ animationDelay: "0.6s" }} />
                </>
              )}
              {/* file tree mounts once at launch — async idle fetch, hidden while booting or on chats tab; skeleton stays until complete */}
              <div style={{ display: loading && sessions.length === 0 ? "none" : tab === "files" ? "block" : "none" }}>
                <FileTree />
              </div>
              <div style={{ display: loading && sessions.length === 0 || tab === "files" ? "none" : "block" }}>
                {!(loading && sessions.length === 0) && sessions.map((s) => {
                  const pinned = !!isPinned?.(s.id);
                  const busy = !!busyIds?.has(s.id);
                  const needsAttention = !!attentionIds?.has(s.id);
                  const attentionKind = attentionKinds?.[s.id] ?? (needsAttention ? "permission" : undefined);
                  return (
                  <div
                    key={s.id}
                    className={`session-row ${s.id === activeId ? "active" : ""}${pinned ? " pinned" : ""}${needsAttention ? ` attention attention-${attentionKind ?? "permission"}` : ""}`}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (renaming === s.id) setRenaming(null);
                      else startRename(s);
                    }}
                    // middle-click anywhere on the row deletes instantly,
                    // no confirmation — preventDefault kills autoscroll
                    onMouseDown={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      onDelete(s.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!ctx) return;
                      const hasShare = true;
                      ctx.show(e.clientX, e.clientY, [
                        { label: "Rename", icon: "fa-pen", action: () => startRename(s) },
                        { label: "Duplicate", icon: "fa-copy", action: () => onDuplicate?.(s.id), disabled: busy },
                        { label: pinned ? "Unpin" : "Pin", icon: "fa-thumbtack", action: () => onTogglePin?.(s.id) },
                        { separator: true },
                        { label: "Copy ID", icon: "fa-id-badge", action: () => void clipboardWrite(s.id) },
                        { label: "Copy Title", icon: "fa-heading", action: () => void clipboardWrite(s.title || s.id) },
                        ...(hasShare ? [{ label: "Share (copy link)", icon: "fa-share", action: async () => {
                          try {
                            const { client } = await opencode();
                            const r: any = await (client as any).session.share?.({ path: { id: s.id } });
                            const url = r?.data?.url || r?.data?.shareUrl || window.location.href + "#session-" + s.id;
                            await clipboardWrite(String(url));
                          } catch { await clipboardWrite(s.id); }
                        }} as any] : []),
                        { separator: true },
                        { label: "Close", icon: "fa-xmark", danger: true, action: () => onDelete(s.id) },
                      ]);
                    }}
                  >
                    {renaming === s.id ? (
                      <input
                        data-rename={s.id}
                        className="session-rename"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                          else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onBlur={commitRename}
                        spellCheck={false}
                      />
                    ) : (
                    <button
                      className="session-item"
                      onClick={() => onOpen(s.id)}
                      data-tip={`${s.title || s.id} — middle-click to close`}
                    >
                      {pinned && <i className="fa-solid fa-thumbtack" style={{ fontSize: 9, marginRight: 4, color: "var(--accent)" }} />}
                      {s.title || "New session"}
                    </button>
                    )}
                    {busy && <span className="row-busy" />}
                    {compactingIds?.has(s.id) && (
                      <span className="row-compacting" data-tip="Compacting context" />
                    )}
                    {needsAttention && (
                      <span
                        className={`row-attention ${attentionKind ?? ""}`}
                        data-tip={
                          attentionKind === "question"
                            ? "Question needs your answer — click to respond"
                            : attentionKind === "permission"
                            ? "Permission needs approval — click to respond"
                            : "Needs your attention — click to respond"
                        }
                      >
                        <i
                          className={`fa-solid ${
                            attentionKind === "question"
                              ? "fa-circle-question"
                              : attentionKind === "permission"
                              ? "fa-shield-halved"
                              : "fa-triangle-exclamation"
                          }`}
                        />
                      </span>
                    )}
                    {!!queueCounts?.[s.id] && (
                      <span className="row-queued" data-tip={`${queueCounts[s.id]} queued`}>
                        {queueCounts[s.id]}
                      </span>
                    )}
                    <button className="del" data-tip="Delete session" onClick={() => onDelete(s.id)}>
                      <i className="fa-solid fa-xmark" />
                    </button>
                  </div>
                    );
                })}
                  </div>
            </div>
            {sidebarExtras}
            <GitPanel />
            <div className="sb-resize" data-tip="Drag to resize" onMouseDown={onStartResize} />
          </>
        )}
      </aside>
    </>
  );
}
