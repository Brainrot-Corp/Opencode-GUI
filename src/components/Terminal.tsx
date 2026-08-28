// bottom-dock multi-terminal: xterm.js front-ends over Rust ConPTYs (src-tauri/src/pty.rs).
// Dock survives hide/show (height collapse) — shells keep running. Right side shows
// instance list with hover reload/kill (2-click kill), collapsed to icon strip.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playSound } from "../lib/sounds";
import { fetchTerminalProfiles, useTerminalProfiles, type TerminalProfile } from "../hooks/useTerminalProfiles";
import TermInstanceView from "./TermInstanceView";
import DropdownPortal from "./DropdownPortal";
import "../styles/terminal.css";

const H_KEY = "oc.term.h";
const H_MIN = 120;
const H_DEFAULT = 240;
const SIDE_KEY = "oc.term.sideCollapsed";
const SIDE_W_KEY = "oc.term.sideW";
const SIDE_W_DEFAULT = 176;
const SIDE_W_MIN = 132;
const SIDE_W_MAX = 360;
const ACTIVE_KEY = "oc.term.active";
const INST_KEY = "oc.term.instances";

// persisted shape for instances — cwd remembered at spawn, title may update from shell, per-terminal shell
type PersistedInst = { id: number; gen: number; cwd: string; title: string; shell?: string; args?: string[]; shellName?: string };

type TermEntry = {
  id: number;
  gen: number;
  title: string;
  cwd: string;
  dead: boolean;
  err: string;
  shell?: string;
  args?: string[];
  shellName?: string;
};

type CustomShell = { id: string; name: string; path: string; args: string };

function parseArgsString(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let sq = false, dq = false;
  for (const ch of s) {
    if (ch === "'" && !dq) { sq = !sq; continue; }
    if (ch === '"' && !sq) { dq = !dq; continue; }
    if ((ch === " " || ch === "\t") && !sq && !dq) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const clampH = (h: number) =>
  Math.min(Math.max(H_MIN, Math.floor(h)), Math.floor(window.innerHeight * 0.7));

export default function TerminalPanel({
  open,
  workspace,
  onClose,
  terminal,
  onSetDefault,
}: {
  open: boolean;
  workspace?: string;
  onClose: () => void;
  terminal?: { defaultProfileId: string | null; customShells: CustomShell[] };
  onSetDefault?: (id: string | null) => void;
}) {
  const [h, setH] = useState(() => clampH(Number(localStorage.getItem(H_KEY)) || 240));
  const [dragging, setDragging] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem(SIDE_KEY) === "1");
  const [sideW, setSideW] = useState(() => {
    const v = Number(localStorage.getItem(SIDE_W_KEY)) || SIDE_W_DEFAULT;
    return Math.min(Math.max(SIDE_W_MIN, v), SIDE_W_MAX);
  });
  const [sideResizing, setSideResizing] = useState(false);
  const [maxErr, setMaxErr] = useState("");
  const { profiles } = useTerminalProfiles();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuPortalRef = useRef<HTMLDivElement>(null);

  const nextIdRef = useRef(1);
  const genCounterRef = useRef(1);

  const [terms, setTerms] = useState<TermEntry[]>(() => {
    try {
      const raw = localStorage.getItem(INST_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as PersistedInst[];
        if (Array.isArray(arr) && arr.length > 0 && arr.length <= 8) {
          let maxId = 0;
          let maxGen = 0;
          for (const a of arr) {
            if (a.id > maxId) maxId = a.id;
            if (a.gen > maxGen) maxGen = a.gen;
          }
          nextIdRef.current = maxId + 1;
          genCounterRef.current = maxGen + 1;
          return arr.map((a) => ({
            id: a.id,
            gen: a.gen,
            cwd: a.cwd || "",
            title: a.title || `Terminal ${a.id}`,
            dead: false,
            err: "",
            shell: a.shell,
            args: a.args,
            shellName: a.shellName,
          }));
        }
      }
    } catch {}
    // fresh: one terminal seeded
    const id = 1;
    const gen = 1;
    nextIdRef.current = 2;
    genCounterRef.current = 2;
    return [{ id, gen, title: `Terminal ${id}`, cwd: workspace ?? "", dead: false, err: "" }];
  });

  const [activeId, setActiveId] = useState<number>(() => {
    const saved = Number(localStorage.getItem(ACTIVE_KEY) || 0);
    if (saved) return saved;
    return terms[0]?.id ?? 1;
  });

  // picker opens before background prefetch finished — trigger shared fetch immediately
  useEffect(() => {
    if (!addMenuOpen) return;
    if (profiles.length) return;
    void fetchTerminalProfiles().catch(() => {});
  }, [addMenuOpen, profiles.length]);

  // close add menu on outside click — portal lives at body, so check both anchor + portaled menu
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!addMenuRef.current?.contains(t) && !addMenuPortalRef.current?.contains(t)) setAddMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAddMenuOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [addMenuOpen]);

  const resolveProfile = useCallback((profileId: string | null | undefined): { path?: string; args?: string[]; name?: string } | null => {
    if (!profileId) return null;
    const customs = terminal?.customShells ?? [];
    const c = customs.find((x) => x.id === profileId);
    if (c) return { path: c.path, args: c.args ? parseArgsString(c.args) : [], name: c.name };
    const p = profiles.find((x) => x.id === profileId);
    if (p) return { path: p.path, args: p.args, name: p.name };
    return null;
  }, [profiles, terminal]);

  // ensure activeId points to existing term
  useEffect(() => {
    if (!terms.some((t) => t.id === activeId)) {
      if (terms.length) setActiveId(terms[0].id);
    }
  }, [terms, activeId]);

  // when panel is reopened empty (last was killed), seed fresh terminal
  useEffect(() => {
    if (open && terms.length === 0) {
      const id = nextIdRef.current++;
      const gen = genCounterRef.current++;
      const cwd = workspaceRef.current ?? "";
      const resolved = resolveProfile(terminal?.defaultProfileId ?? null);
      const entry: TermEntry = {
        id, gen, title: `Terminal ${id}`, cwd, dead: false, err: "",
        shell: resolved?.path, args: resolved?.args, shellName: resolved?.name,
      };
      setTerms([entry]);
      setActiveId(id);
    }
  }, [open, terms.length, resolveProfile, terminal?.defaultProfileId]);

  // persist side + active + instances (lightweight)
  useEffect(() => { localStorage.setItem(SIDE_KEY, sideCollapsed ? "1" : "0"); }, [sideCollapsed]);
  useEffect(() => { localStorage.setItem(SIDE_W_KEY, String(sideW)); }, [sideW]);
  useEffect(() => { localStorage.setItem(ACTIVE_KEY, String(activeId)); }, [activeId]);
  useEffect(() => {
    try {
      const arr: PersistedInst[] = terms.map((t) => ({ id: t.id, gen: t.gen, cwd: t.cwd, title: t.title, shell: t.shell, args: t.args, shellName: t.shellName }));
      localStorage.setItem(INST_KEY, JSON.stringify(arr));
    } catch {}
  }, [terms]);
  useEffect(() => { localStorage.setItem(H_KEY, String(h)); }, [h]);

  const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

  const onTitle = useCallback((id: number, title: string) => {
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, title: title.slice(0, 80) } : t)));
  }, []);
  const onDead = useCallback((id: number, dead: boolean) => {
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, dead } : t)));
  }, []);
  const onErr = useCallback((id: number, err: string) => {
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, err } : t)));
  }, []);

  const addTerm = useCallback((profileId?: string | null) => {
    if (terms.length >= 8) {
      setMaxErr("max 8 terminals");
      window.setTimeout(() => setMaxErr(""), 2500);
      playSound("click");
      return;
    }
    const id = nextIdRef.current++;
    const gen = genCounterRef.current++;
    const cwd = workspaceRef.current ?? "";
    const pid = profileId !== undefined ? profileId : (terminal?.defaultProfileId ?? null);
    const resolved = resolveProfile(pid);
    const entry: TermEntry = {
      id, gen, title: `Terminal ${id}`, cwd, dead: false, err: "",
      shell: resolved?.path, args: resolved?.args, shellName: resolved?.name ?? (pid ? undefined : "System default"),
    };
    setTerms((prev) => [...prev, entry]);
    setActiveId(id);
    playSound("click");
    setAddMenuOpen(false);
  }, [terms.length, terminal?.defaultProfileId, resolveProfile]);

  const reloadTerm = useCallback(async (id: number) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return;
    playSound("click");
    // kill old gen before bumping — view will spawn with new gen
    await invoke("pty_kill", { id, gen: t.gen }).catch(() => {});
    const newGen = genCounterRef.current++;
    setTerms((prev) => prev.map((x) => (x.id === id ? { ...x, gen: newGen, dead: false, err: "" } : x)));
  }, [terms]);

  const changeTermShell = useCallback(async (id: number, profileId: string | null) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return;
    playSound("click");
    await invoke("pty_kill", { id, gen: t.gen }).catch(() => {});
    const resolved = resolveProfile(profileId);
    const newGen = genCounterRef.current++;
    setTerms((prev) => prev.map((x) => (x.id === id ? { ...x, gen: newGen, dead: false, err: "", shell: resolved?.path, args: resolved?.args, shellName: resolved?.name ?? (profileId ? undefined : "System default") } : x)));
  }, [terms, resolveProfile]);

  const killTerm = useCallback(async (id: number) => {
    const t = terms.find((x) => x.id === id);
    if (t) {
      await invoke("pty_kill", { id, gen: t.gen }).catch(() => {});
    }
    playSound("close");
    setTerms((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const next = prev.filter((x) => x.id !== id);
      if (next.length === 0) {
        // last terminal killed — hide panel and keep empty; next open seeds fresh
        setTimeout(() => onClose(), 0);
        return [];
      }
      if (activeId === id) {
        const newActive = next[Math.min(idx, next.length - 1)]?.id ?? next[0].id;
        setTimeout(() => setActiveId(newActive), 0);
      }
      return next;
    });
  }, [terms, activeId, onClose]);

  // vertical resize handle (same as single-terminal version)
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = h;
    let lastTick = 0;
    setDragging(true);
    document.body.classList.add("resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const move = (ev: MouseEvent) => {
      setH(clampH(startH + (startY - ev.clientY)));
      const now = performance.now();
      if (now - lastTick > 70) { lastTick = now; playSound("resize"); }
    };
    const up = () => {
      setDragging(false);
      document.body.classList.remove("resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
  }, [h]);

  const resetSize = useCallback(() => { setH(H_DEFAULT); playSound("click"); }, []);

  // horizontal resize for expanded side panel — mirrors sidebar drag
  const startSideResize = useCallback((e: React.MouseEvent) => {
    if (sideCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideW;
    let lastTick = 0;
    setSideResizing(true);
    document.body.classList.add("resizing");
    (document.body as any).__termSideResizing = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: MouseEvent) => {
      const next = Math.min(Math.max(SIDE_W_MIN, startW + (startX - ev.clientX)), SIDE_W_MAX);
      setSideW(next);
      const now = performance.now();
      if (now - lastTick > 70) { lastTick = now; playSound("resize"); }
    };
    const up = () => {
      setSideResizing(false);
      document.body.classList.remove("resizing");
      delete (document.body as any).__termSideResizing;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
  }, [sideW, sideCollapsed]);

  const activeTerm = terms.find((t) => t.id === activeId);

  // Ctrl+Tab / Ctrl+Shift+Tab when focus is inside the terminal dock → cycle terminals
  // (sessions list uses the same chord globally; when the terminal has focus we steal it)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.key !== "Tab") return;
      const target = e.target as HTMLElement | null;
      const ae = document.activeElement as HTMLElement | null;
      const inTerm = !!target?.closest?.(".term-dock") || !!ae?.closest?.(".term-dock");
      if (!inTerm || !open || terms.length <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      // also block the global session cycler (bubble listener on window)
      (e as any).stopImmediatePropagation?.();
      const dir: 1 | -1 = e.shiftKey ? -1 : 1;
      const idx = terms.findIndex((t) => t.id === activeId);
      if (idx === -1) return;
      const nextIdx = (idx + dir + terms.length) % terms.length;
      const nextId = terms[nextIdx].id;
      setActiveId(nextId);
      playSound("click");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, terms, activeId]);

  return (
    <div className={`term-dock${open ? "" : " closed"}${dragging ? " dragging" : ""}`} style={{ height: open ? h : 0 }}>
      <div className="term-resize" data-tip="Drag to resize · double-click to reset" onMouseDown={startResize} onDoubleClick={resetSize}>
        <i className="fa-solid fa-grip-lines" aria-hidden="true" />
      </div>
      <div className="term-head" onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) resetSize(); }}>
        <i className="fa-solid fa-terminal" />
        <span>terminal</span>
        {terms.length > 1 && <span className="term-count">{terms.length}/8</span>}
        {maxErr && <span className="term-err">{maxErr}</span>}
        {activeTerm?.err && !maxErr && <span className="term-err">{activeTerm.err}</span>}
        {activeTerm?.dead && !activeTerm?.err && !maxErr && <span className="term-dead">exited</span>}
        <span className="term-spacer" />
        {activeTerm && (
          <>
            <button className="icon-btn term-btn" data-tip="Reload active terminal" onClick={() => void reloadTerm(activeTerm.id)}>
              <i className="fa-solid fa-rotate" />
            </button>
            <button
              className="icon-btn term-btn"
              data-tip="Kill active terminal"
              onClick={() => void killTerm(activeTerm.id)}
            >
              <i className="fa-solid fa-trash-can" />
            </button>
          </>
        )}
        <button className="icon-btn term-btn" data-tip="Hide panel" onClick={onClose}>
          <i className="fa-solid fa-chevron-down" />
        </button>
      </div>
      <div className="term-main">
        <div className="term-views">
          {terms.map((t) => (
            <TermInstanceView
              key={t.id}
              id={t.id}
              gen={t.gen}
              cwd={t.cwd}
              shell={t.shell}
              args={t.args}
              shellName={t.shellName}
              active={t.id === activeId}
              open={open}
              onTitle={onTitle}
              onDead={onDead}
              onErr={onErr}
            />
          ))}
        </div>
        <div className={`term-side${sideCollapsed ? " collapsed" : ""}${sideResizing ? " resizing" : ""}`} style={!sideCollapsed ? { width: sideW } : undefined}>
          {!sideCollapsed && <div className="term-side-resize" onMouseDown={startSideResize} />}
          <div className="term-side-head">
            {!sideCollapsed && <span>instances</span>}
            <span className="term-side-spacer" />
            {!sideCollapsed && (
              <>
                <div ref={addMenuRef} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                  <button className="icon-btn term-btn small" data-tip="New terminal (default shell)" onClick={() => addTerm()}>
                    <i className="fa-solid fa-plus" />
                  </button>
                  <button className="icon-btn term-btn small" data-tip="New terminal with shell…" onClick={() => setAddMenuOpen((v) => !v)} style={{ width: "18px" }}>
                    <i className={`fa-solid fa-caret-${addMenuOpen ? "up" : "down"}`} style={{ fontSize: "8px" }} />
                  </button>
                </div>
                <DropdownPortal anchor={addMenuRef} open={addMenuOpen} align="right" prefer="down">
                  <div className="term-add-menu" ref={addMenuPortalRef}>
                    <button className="term-add-item" onClick={() => addTerm(null)} onContextMenu={(e)=>{e.preventDefault(); addTerm(null); onSetDefault?.(null);}} data-tip="powershell.exe · Right-click to open & set as default"><i className="fa-solid fa-terminal" /> System default (PowerShell)</button>
                    {!profiles.length && (
                      <>
                        <div className="skel-row" style={{ height: 28, margin: "4px 8px", opacity: 0.6 }} />
                        <div className="skel-row" style={{ height: 28, margin: "4px 8px", animationDelay: "0.15s", opacity: 0.6 }} />
                      </>
                    )}
                    {(() => {
                      const groups: Record<string, TerminalProfile[]> = { probe: [], wsl: [], wt: [] };
                      for (const p of profiles) {
                        if (p.source === "wsl") groups.wsl.push(p);
                        else if (p.source === "wt") groups.wt.push(p);
                        else groups.probe.push(p);
                      }
                      const customs = terminal?.customShells ?? [];
                      return (
                        <>
                          {groups.probe.length > 0 && (
                            <>
                              <div className="term-add-group">Installed shells</div>
                              {groups.probe.map((p) => (
                                <button key={p.id} className="term-add-item" onClick={() => addTerm(p.id)} onContextMenu={(e)=>{e.preventDefault(); addTerm(p.id); onSetDefault?.(p.id);}} data-tip={`${p.path} ${p.args.join(" ")} · Right-click to open & set as default`}><i className="fa-solid fa-terminal" /> {p.name}</button>
                              ))}
                            </>
                          )}
                          {groups.wsl.length > 0 && (
                            <>
                              <div className="term-add-group">WSL</div>
                              {groups.wsl.map((p) => (
                                <button key={p.id} className="term-add-item" onClick={() => addTerm(p.id)} onContextMenu={(e)=>{e.preventDefault(); addTerm(p.id); onSetDefault?.(p.id);}} data-tip={`${p.path} ${p.args.join(" ")} · Right-click to open & set as default`}><i className="fa-solid fa-cube" /> {p.name}</button>
                              ))}
                            </>
                          )}
                          {groups.wt.length > 0 && (
                            <>
                              <div className="term-add-group">Windows Terminal</div>
                              {groups.wt.map((p) => (
                                <button key={p.id} className="term-add-item" onClick={() => addTerm(p.id)} onContextMenu={(e)=>{e.preventDefault(); addTerm(p.id); onSetDefault?.(p.id);}} data-tip={`${p.path} ${p.args.join(" ")} · Right-click to open & set as default`}><i className="fa-solid fa-window-restore" /> {p.name}</button>
                              ))}
                            </>
                          )}
                          {customs.length > 0 && (
                            <>
                              <div className="term-add-group">Custom</div>
                              {customs.map((c) => (
                                <button key={c.id} className="term-add-item" onClick={() => addTerm(c.id)} onContextMenu={(e)=>{e.preventDefault(); addTerm(c.id); onSetDefault?.(c.id);}} data-tip={`${c.path} ${c.args} · Right-click to open & set as default`}><i className="fa-solid fa-wrench" /> {c.name}</button>
                              ))}
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </DropdownPortal>
              </>
            )}
            <button
              className="icon-btn term-btn small"
              data-tip={sideCollapsed ? "Expand list" : "Collapse list"}
              onClick={() => { playSound("click"); setSideCollapsed((v) => !v); }}
            >
              <i className={`fa-solid ${sideCollapsed ? "fa-chevron-left" : "fa-chevron-right"}`} />
            </button>
          </div>
          <div className="term-inst-list">
            {terms.map((t) => (
              <div
                key={t.id}
                className={`term-inst-row${t.id === activeId ? " active" : ""}${t.dead ? " dead" : ""}`}
                onClick={() => setActiveId(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // quick switch via context menu: cycle through shell picker for this term
                  // For now show add menu re-purposed — user can change shell via reload with new shell
                  // We expose a simple prompt via the add menu: reuse addMenuOpen logic with switch
                  // Instead implement inline: if user right-clicks, open a small switch menu
                  const pid = prompt(`Switch shell for Terminal ${t.id} — enter profile id (empty = default). Available: ${profiles.map(p=>p.id).join(", ")} ${terminal?.customShells.map(c=>c.id).join(", ")}`);
                  if (pid !== null) {
                    const trimmed = pid.trim();
                    void changeTermShell(t.id, trimmed || null);
                  }
                }}
                data-tip={sideCollapsed ? `${t.title}${t.shellName ? " — " + t.shellName : ""}${t.cwd ? " — " + t.cwd : ""}${t.dead ? " (exited)" : ""}` : undefined}
                title={t.shellName ? `${t.title} — ${t.shellName}` : t.title}
              >
                <i className="fa-solid fa-terminal term-inst-ico" />
                {!sideCollapsed && (
                  <>
                    <div className="term-inst-info">
                      <span className="term-inst-title" title={t.title}>{t.title}</span>
                      <span className="term-inst-cwd" title={t.shell ? `${t.shell} ${t.args?.join(" ") ?? ""} — ${t.cwd}` : t.cwd}>{t.shellName ?? (t.cwd ? t.cwd.split(/[/\\]/).pop() : "—")}</span>
                    </div>
                    <span className="term-inst-spacer" />
                    <span className="term-inst-actions">
                      <button
                        className="icon-btn term-btn small"
                        data-tip="Reload terminal"
                        onClick={(e) => { e.stopPropagation(); void reloadTerm(t.id); }}
                      >
                        <i className="fa-solid fa-rotate" />
                      </button>
                      <button
                        className="icon-btn term-btn small close"
                        data-tip="Kill terminal"
                        onClick={(e) => { e.stopPropagation(); void killTerm(t.id); }}
                      >
                        <i className="fa-solid fa-trash-can" />
                      </button>
                    </span>
                  </>
                )}
                {sideCollapsed && t.dead && <span className="term-inst-dot dead" />}
                {sideCollapsed && !t.dead && t.id === activeId && <span className="term-inst-dot active" />}
              </div>
            ))}
          </div>
          {sideCollapsed && (
            <div className="term-side-foot">
              <button className="icon-btn term-btn small" data-tip="New terminal (default shell)" onClick={() => addTerm()}>
                <i className="fa-solid fa-plus" />
              </button>
            </div>
          )}
          {!sideCollapsed && terms.length >= 8 && <div className="term-side-hint">max 8 reached</div>}
        </div>
      </div>
    </div>
  );
}
