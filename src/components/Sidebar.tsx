import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@opencode-ai/sdk/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playSound } from "../lib/sounds";
import { useContextMenu } from "../hooks/useContextMenu";
import { clipboardWrite } from "../lib/clipboard";
import { opencode, getDirectory } from "../api";
import { addWorkspace, removeWorkspace, reorderWorkspaces } from "../lib/workspace";
import FileTree from "./FileTree";
import GitPanel from "./GitPanel";
import "../styles/sidebar.css";

const WS_COLLAPSED_KEY = "oc.ws.collapsed";
function getWsCollapsed(): Record<string, boolean> {
  try { const raw = localStorage.getItem(WS_COLLAPSED_KEY); if (raw) { const o = JSON.parse(raw); if (o && typeof o === "object") return o; } } catch {}
  return {};
}
function setWsCollapsed(map: Record<string, boolean>) {
  try { localStorage.setItem(WS_COLLAPSED_KEY, JSON.stringify(map)); } catch {}
}
function baseName(p: string): string {
  if (!p) return "Server cwd";
  const t = p.replace(/[\/\\]+$/, "");
  const idx = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return idx >= 0 ? t.slice(idx + 1) : t;
}

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
  onClearForDir,
  onRename,
  onDuplicate,
  onTogglePin,
  isPinned,
  sidebarExtras,
  getDirForSession,
  refreshSessions,
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
  onNew: (dir?: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClearForDir?: (dir: string) => void;
  onRename?: (id: string, title: string) => void;
  onDuplicate?: (id: string) => void;
  onTogglePin?: (id: string) => void;
  isPinned?: (id: string) => boolean;
  sidebarExtras?: React.ReactNode;
  getDirForSession?: (id: string) => string;
  refreshSessions?: () => void;
}) {
  const [tab, setTab] = useState(() =>
    localStorage.getItem("oc.sb.tab") === "files" ? "files" : "chats",
  );
  const [clearConfirm, setClearConfirm] = useState<string | null>(null);
  const clearTimer = useRef(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [wsCollapsed, setWsCollapsedState] = useState<Record<string, boolean>>(() => getWsCollapsed());
  const [confirmWs, setConfirmWs] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragReorder, setDragReorder] = useState<number | null>(null);
  const wsConfirmTimer = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctx = (() => { try { return useContextMenu(); } catch { return null; } })();
  const switchTab = (t: "chats" | "files") => {
    if (t === tab) return;
    playSound("click");
    setTab(t);
    localStorage.setItem("oc.sb.tab", t);
  };

  // workspaces derived from settings + primary — live sync via storage + custom event
  const [allDirs, setAllDirs] = useState<string[]>(() => {
    try {
      const p = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
      const primary = typeof p.workspace === "string" ? p.workspace : getDirectory();
      const extras = Array.isArray(p.workspaces) ? p.workspaces : [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const d of [primary, ...extras]) { const k = (d ?? "").toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(d ?? ""); }
      return out;
    } catch { return [getDirectory()]; }
  });
  useEffect(() => {
    const sync = () => {
      try {
        const p = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
        const primary = typeof p.workspace === "string" ? p.workspace : getDirectory();
        const extras = Array.isArray(p.workspaces) ? p.workspaces : [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const d of [primary, ...extras]) { const k = (d ?? "").toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(d ?? ""); }
        setAllDirs(out);
      } catch {}
    };
    window.addEventListener("storage", sync);
    window.addEventListener("oc:workspaces-changed", sync as any);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("oc:workspaces-changed", sync as any); window.removeEventListener("focus", sync); };
  }, []);
  const primaryDir = allDirs[0] ?? getDirectory();
  const extraDirs = allDirs.slice(1);

  // drag-drop: Tauri payload + HTML fallback
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("tauri://drag-drop", (e: any) => {
      const payload = e.payload as { paths?: string[]; position?: { x: number; y: number } };
      const paths: string[] = Array.isArray(payload?.paths) ? payload.paths : Array.isArray((e as any).payload) ? (e as any).payload : [];
      let idx: number | null = dropIndex;
      if (payload?.position && scrollRef.current) {
        const headers = [...scrollRef.current.querySelectorAll<HTMLElement>("[data-ws-header]")];
        const y = payload.position.y;
        let rawIdx = headers.length;
        for (let i = 0; i < headers.length; i++) {
          const r = headers[i].getBoundingClientRect();
          if (y < r.top + r.height / 2) { rawIdx = i; break; }
        }
        idx = Math.max(0, rawIdx - 1);
      }
      void handleDropPaths(paths, idx);
      setDragOver(false); setDropIndex(null);
    }).then(f => un = f).catch(() => {});
    const onEnter = () => setDragOver(true);
    const onLeave = () => setDragOver(false);
    window.addEventListener("dragenter", onEnter as any);
    window.addEventListener("dragleave", onLeave as any);
    return () => { un?.(); window.removeEventListener("dragenter", onEnter as any); window.removeEventListener("dragleave", onLeave as any); };
  }, [dropIndex]);
  // html drag over for placement hint
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
    const container = scrollRef.current;
    if (!container) return;
    const headers = [...container.querySelectorAll<HTMLElement>("[data-ws-header]")];
    if (!headers.length) { setDropIndex(extraDirs.length); return; }
    const rawHeaders = headers;
    let rawIdx = rawHeaders.length;
    for (let i = 0; i < rawHeaders.length; i++) {
      const r = rawHeaders[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { rawIdx = i; break; }
    }
    const extraIdx = Math.max(0, rawIdx - 1);
    setDropIndex(Math.min(extraIdx, extraDirs.length));
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) { setDragOver(false); setDropIndex(null); }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (dragReorder !== null && typeof dropIndex === "number") {
      const from = dragReorder;
      const to = dropIndex;
      setDragReorder(null);
      if (from !== to && from !== to - (from < to ? 1 : 0)) {
        reorderWorkspaces(from, to > from ? to - 1 : to);
        playSound("click");
        refreshSessions?.();
      }
      setDropIndex(null);
      return;
    }
    const dt = e.dataTransfer;
    const paths: string[] = [];
    if (dt?.files) for (const f of Array.from(dt.files) as any[]) if ((f as any).path) paths.push((f as any).path);
    if (!paths.length && dt?.getData("text/plain")) {
      const txt = dt.getData("text/plain");
      for (const line of txt.split("\n")) { const t = line.trim(); if (t && (t.includes("\\") || t.includes("/"))) paths.push(t); }
    }
    if (paths.length) await handleDropPaths(paths, dropIndex);
    setDropIndex(null);
    setDragReorder(null);
  };
  async function handleDropPaths(paths: string[], atExtraIdx: number | null) {
    let idx = typeof atExtraIdx === "number" ? atExtraIdx : extraDirs.length;
    for (const p of paths) {
      const ok = await addWorkspace(p, idx);
      if (ok) { idx++; playSound("click"); }
    }
    if (paths.length) refreshSessions?.();
  }

  const toggleWs = (dir: string) => {
    const next = { ...wsCollapsed, [dir]: !wsCollapsed[dir] };
    setWsCollapsedState(next); setWsCollapsed(next);
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

  // group sessions by dir
  const byDir = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const d of allDirs) m.set(d, []);
    for (const s of sessions) {
      const d = getDirForSession ? getDirForSession(s.id) : primaryDir;
      const key = allDirs.find(a => a.toLowerCase() === (d ?? "").toLowerCase()) ?? d;
      const arr = m.get(key);
      if (arr) arr.push(s);
      else m.set(key!, [s]);
    }
    return m;
  }, [sessions, allDirs, getDirForSession, primaryDir]);

  const renderSessionRow = (s: Session) => {
    const pinned = !!isPinned?.(s.id);
    const busy = !!busyIds?.has(s.id);
    const needsAttention = !!attentionIds?.has(s.id);
    const attentionKind = attentionKinds?.[s.id] ?? (needsAttention ? "permission" : undefined);
    return (
      <div
        key={s.id}
        className={`session-row ${s.id === activeId ? "active" : ""}${pinned ? " pinned" : ""}${needsAttention ? ` attention attention-${attentionKind ?? "permission"}` : ""}`}
        onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); if (renaming === s.id) setRenaming(null); else startRename(s); }}
        onMouseDown={(e) => { if (e.button !== 1) return; e.preventDefault(); onDelete(s.id); }}
        onContextMenu={(e) => {
          e.preventDefault(); if (!ctx) return;
          ctx.show(e.clientX, e.clientY, [
            { label: "Rename", icon: "fa-pen", action: () => startRename(s) },
            { label: "Duplicate", icon: "fa-copy", action: () => onDuplicate?.(s.id), disabled: busy },
            { label: pinned ? "Unpin" : "Pin", icon: "fa-thumbtack", action: () => onTogglePin?.(s.id) },
            { separator: true },
            { label: "Copy ID", icon: "fa-id-badge", action: () => void clipboardWrite(s.id) },
            { label: "Copy Title", icon: "fa-heading", action: () => void clipboardWrite(s.title || s.id) },
            { label: "Share (copy link)", icon: "fa-share", action: async () => { try { const { client } = await opencode(); const r: any = await (client as any).session.share?.({ path: { id: s.id } }); const url = r?.data?.url || r?.data?.shareUrl || window.location.href + "#session-" + s.id; await clipboardWrite(String(url)); } catch { await clipboardWrite(s.id); } } },
            { separator: true },
            { label: "Close", icon: "fa-xmark", danger: true, action: () => onDelete(s.id) },
          ]);
        }}
      >
        {renaming === s.id ? (
          <input data-rename={s.id} className="session-rename" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitRename(); } else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); } }} onDoubleClick={(e) => e.stopPropagation()} onBlur={commitRename} spellCheck={false} />
        ) : (
          <button className="session-item" onClick={() => onOpen(s.id)} data-tip={`${s.title || s.id} — middle-click to close`}>
            {pinned && <i className="fa-solid fa-thumbtack" style={{ fontSize: 9, marginRight: 4, color: "var(--accent)" }} />}
            {s.title || "New session"}
          </button>
        )}
        {busy && <span className="row-busy" />}
        {compactingIds?.has(s.id) && <span className="row-compacting" data-tip="Compacting context" />}
        {needsAttention && <span className={`row-attention ${attentionKind ?? ""}`} data-tip={attentionKind === "question" ? "Question needs your answer — click to respond" : attentionKind === "permission" ? "Permission needs approval — click to respond" : "Needs your attention — click to respond"}><i className={`fa-solid ${attentionKind === "question" ? "fa-circle-question" : attentionKind === "permission" ? "fa-shield-halved" : "fa-triangle-exclamation"}`} /></span>}
        {!!queueCounts?.[s.id] && <span className="row-queued" data-tip={`${queueCounts[s.id]} queued`}>{queueCounts[s.id]}</span>}
        <button className="del" data-tip="Delete session" onClick={() => onDelete(s.id)}><i className="fa-solid fa-xmark" /></button>
      </div>
    );
  };

  const dropHint = (idx: number) => dropIndex === idx && dragOver ? <div className="ws-drop-hint" /> : null;

  return (
    <>
      <aside
        className={`sidebar${collapsed ? " collapsed" : ""}${resizing ? " resizing" : ""}${dragOver ? " drag-over" : ""}`}
        {...(collapsed ? ({ "data-tip": "Show session history (Ctrl+B)", "data-tip-cursor": "" } as any) : {})}
        onClick={collapsed ? () => { playSound("expand"); onToggle(); } : undefined}
        onDragOver={collapsed ? undefined : onDragOver}
        onDragLeave={collapsed ? undefined : onDragLeave}
        onDrop={collapsed ? undefined : onDrop}
      >
        {collapsed ? (
          <>
            <button className="icon-btn sb-expand"><i className="fa-solid fa-angles-right" /></button>
            {!!attentionIds?.size && <span className="sb-attention-badge" data-tip={`${attentionIds.size} session${attentionIds.size > 1 ? "s" : ""} need${attentionIds.size === 1 ? "s" : ""} your attention — click to show`} aria-label="Attention needed">{attentionIds.size > 1 ? attentionIds.size : <i className="fa-solid fa-bell" />}</span>}
            <div style={{ display: "none" }}><GitPanel /><>{sidebarExtras}</></div>
          </>
        ) : (
          <>
            <div className="sb-scroll" ref={scrollRef}>
              <div className="sb-head">
                <div className="sb-tabs" role="tablist">
                  <button role="tab" aria-selected={tab === "chats"} className={tab === "chats" ? "active" : ""} onClick={() => switchTab("chats")}><i className="fa-solid fa-comments" />Chats</button>
                  <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "active" : ""} onClick={() => switchTab("files")}><i className="fa-solid fa-folder-tree" />Files</button>
                </div>
                <button className="icon-btn sb-toggle" data-tip="Hide panel (Ctrl+B)" onClick={() => { playSound("collapse"); onToggle(); }}><i className="fa-solid fa-angles-left" /></button>
              </div>

              {loading && sessions.length === 0 && (
                <>
                  <div className="skel-row" /><div className="skel-row" style={{ animationDelay: "0.15s" }} /><div className="skel-row" style={{ animationDelay: "0.3s" }} />
                </>
              )}

              {/* Files tab: one FileTree per workspace with collapsable header */}
              <div style={{ display: loading && sessions.length === 0 ? "none" : tab === "files" ? "block" : "none" }}>
                {allDirs.map((dir, i) => {
                  const isCollapsed = !!wsCollapsed[dir];
                  const isPrimary = i === 0;
                  const confirming = confirmWs === dir;
                  const extraIdx = i - 1;
                  return (
                    <div key={`ft-${dir || "__cwd"}`} data-ws-header>
                      {dropHint(isPrimary ? 0 : extraIdx)}
                      <div className="gp-sect ws-head ws-head--large" role="button" tabIndex={0} draggable={!isPrimary} onDragStart={() => { if (!isPrimary) setDragReorder(extraIdx); }} onDragEnd={() => { setDragReorder(null); setDropIndex(null); }} onClick={() => toggleWs(dir)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWs(dir); } }} data-tip={dir || "Server cwd"} style={!isPrimary ? { cursor: "grab" } : undefined}>
                        <span className="gp-sect-toggle ws-toggle--large"><i className={`fa-solid fa-chevron-${isCollapsed ? "right" : "down"} gp-sect-chev`} /><i className="fa-solid fa-folder" style={{ fontSize: 13, color: "var(--accent)", opacity: 0.9 }} /><span className="ws-title mono" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{baseName(dir)}</span><span className="gp-sect-count">{dir ? "" : ""}</span></span>
                        <span className="gp-sect-acts ws-acts--large" onClick={(e) => e.stopPropagation()}>
                          <button className="gp-sact ws-action--large" data-tip="Reveal in Explorer" onClick={() => { const p = dir || primaryDir; if (p) void invoke("file_reveal", { path: p }).catch(()=>{}); }}><i className="fa-solid fa-folder-open" /></button>
                          <button className="gp-sact ws-action--large" data-tip="Copy path" onClick={() => void clipboardWrite(dir)}><i className="fa-solid fa-link" /></button>
                          {!isPrimary && (
                            confirming ? (
                              <>
                                <button className="gp-sact ws-action--large danger" data-tip="Really remove workspace" onClick={() => { setConfirmWs(null); window.clearTimeout(wsConfirmTimer.current); removeWorkspace(dir); refreshSessions?.(); }}><i className="fa-solid fa-check" /></button>
                                <button className="gp-sact ws-action--large" data-tip="Keep" onClick={() => { setConfirmWs(null); window.clearTimeout(wsConfirmTimer.current); }}><i className="fa-solid fa-xmark" /></button>
                              </>
                            ) : (
                              <button className="gp-sact ws-action--large" data-tip="Remove workspace" onClick={() => { playSound("click"); setConfirmWs(dir); window.clearTimeout(wsConfirmTimer.current); wsConfirmTimer.current = window.setTimeout(() => setConfirmWs(null), 3000); }}><i className="fa-solid fa-xmark" /></button>
                            )
                          )}
                        </span>
                      </div>
                      {!isCollapsed && <div className="ws-body"><FileTree dir={dir} /></div>}
                    </div>
                  );
                })}
                {dropHint(extraDirs.length)}
                {dragOver && <div className="ws-drop-zone">Drop folder to add workspace</div>}
              </div>

              {/* Chats tab: grouped sessions */}
              <div style={{ display: loading && sessions.length === 0 || tab === "files" ? "none" : "block" }}>
                {allDirs.map((dir, idx) => {
                  const list = byDir.get(dir) ?? [];
                  const isCollapsed = !!wsCollapsed[dir];
                  const isPrimary = idx === 0;
                  const confirming = confirmWs === dir;
                  const extraIdx = idx - 1;
                  const clearArmed = clearConfirm === dir;
                  return (
                    <div key={`ch-${dir || "__cwd"}`} data-ws-header>
                      {dropHint(isPrimary ? 0 : extraIdx)}
                      <div className="gp-sect ws-head ws-head--large" role="button" tabIndex={0} draggable={!isPrimary} onDragStart={() => { if (!isPrimary) setDragReorder(extraIdx); }} onDragEnd={() => { setDragReorder(null); setDropIndex(null); }} onClick={() => toggleWs(dir)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWs(dir); } }} data-tip={dir || "Server cwd"} style={!isPrimary ? { cursor: "grab" } : undefined}>
                        <span className="gp-sect-toggle ws-toggle--large"><i className={`fa-solid fa-chevron-${isCollapsed ? "right" : "down"} gp-sect-chev`} /><i className="fa-solid fa-folder" style={{ fontSize: 13, color: "var(--accent)", opacity: 0.9 }} /><span className="ws-title mono" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{baseName(dir)}</span><span className="gp-sect-count">{list.length}</span></span>
                        <span className="gp-sect-acts ws-acts--large" onClick={(e) => e.stopPropagation()}>
                          <button className="gp-sact ws-action--large" data-tip={`New chat in ${baseName(dir)}`} onClick={() => onNew(dir)}><i className="fa-solid fa-plus" />New</button>
                          {!!list.length && (
                            clearArmed ? (
                              <>
                                <button className="gp-sact ws-action--large danger" data-tip="Really clear all sessions in this workspace?" onClick={() => { window.clearTimeout(clearTimer.current); setClearConfirm(null); onClearForDir ? onClearForDir(dir) : onClearAll(); }}><i className="fa-solid fa-check" /></button>
                                <button className="gp-sact ws-action--large" data-tip="Keep" onClick={() => { window.clearTimeout(clearTimer.current); setClearConfirm(null); }}><i className="fa-solid fa-xmark" /></button>
                              </>
                            ) : (
                              <button className="gp-sact ws-action--large" data-tip="Clear sessions in this workspace" onClick={() => { playSound("click"); setClearConfirm(dir); window.clearTimeout(clearTimer.current); clearTimer.current = window.setTimeout(() => setClearConfirm(null), 3000); }}><i className="fa-solid fa-trash-can" /></button>
                            )
                          )}
                          {!isPrimary && (
                            confirming ? (
                              <>
                                <button className="gp-sact ws-action--large danger" data-tip="Really remove workspace" onClick={() => { setConfirmWs(null); window.clearTimeout(wsConfirmTimer.current); removeWorkspace(dir); refreshSessions?.(); }}><i className="fa-solid fa-check" /></button>
                                <button className="gp-sact ws-action--large" data-tip="Keep" onClick={() => { setConfirmWs(null); window.clearTimeout(wsConfirmTimer.current); }}><i className="fa-solid fa-xmark" /></button>
                              </>
                            ) : (
                              <button className="gp-sact ws-action--large" data-tip="Remove workspace" onClick={() => { playSound("click"); setConfirmWs(dir); window.clearTimeout(wsConfirmTimer.current); wsConfirmTimer.current = window.setTimeout(() => setConfirmWs(null), 3000); }}><i className="fa-solid fa-xmark" /></button>
                            )
                          )}
                        </span>
                      </div>
                      {!isCollapsed && (
                        <div className="ws-body">
                          {list.length === 0 ? <div className="gp-empty">No sessions</div> : list.map(renderSessionRow)}
                        </div>
                      )}
                    </div>
                  );
                })}
                {dropHint(extraDirs.length)}
                {dragOver && <div className="ws-drop-zone">Drop folder to add workspace</div>}
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
