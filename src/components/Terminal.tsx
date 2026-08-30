// bottom-dock multi-terminal: xterm.js front-ends over Rust ConPTYs (src-tauri/src/pty.rs).
// Dock survives hide/show (height collapse) — shells keep running. Right side shows
// instance list with hover reload/kill (2-click kill), collapsed to icon strip.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { playSound } from "../lib/sounds";
import { fetchTerminalProfiles, useTerminalProfiles, type TerminalProfile } from "../hooks/useTerminalProfiles";
import TermInstanceView from "./TermInstanceView";
import DropdownPortal from "./DropdownPortal";
import "../styles/terminal.css";

const H_KEY = "oc.term.h";
const H_MIN = 160;
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
  onToggle,
  terminal,
  onSetDefault,
}: {
  open: boolean;
  workspace?: string;
  onClose: () => void;
  onToggle?: () => void;
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
  // auto-collapse side on narrow viewports on first mount so cols stay readable
  // CSS @media (max-width:720px) is the runtime safety net for resizes
  useEffect(() => {
    if (window.innerWidth < 720 && localStorage.getItem(SIDE_KEY) !== "1") {
      setSideCollapsed(true);
    }
  }, []);
  const { profiles } = useTerminalProfiles();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [switchMenu, setSwitchMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const switchMenuRef = useRef<HTMLDivElement>(null);
  // prevent height transition on first paint — avoids flash open→close on app launch
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 350);
    return () => window.clearTimeout(id);
  }, []);
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
          // validate shape — discard corrupted entries instead of crashing
          const valid = arr.filter((a) => a && typeof a === "object" && Number.isInteger((a as any).id) && (a as any).id > 0 && Number.isInteger((a as any).gen) && (a as any).gen > 0);
          if (valid.length > 0 && valid.length === arr.length) {
            let maxId = 0;
            let maxGen = 0;
            for (const a of valid) {
              if (a.id > maxId) maxId = a.id;
              if (a.gen > maxGen) maxGen = a.gen;
            }
            nextIdRef.current = maxId + 1;
            genCounterRef.current = maxGen + 1;
            return valid.map((a) => ({
              id: a.id,
              gen: a.gen,
              cwd: typeof a.cwd === "string" ? a.cwd : "",
              title: typeof a.title === "string" ? a.title : `Terminal ${a.id}`,
              dead: false,
              err: "",
              shell: typeof a.shell === "string" ? a.shell : undefined,
              args: Array.isArray(a.args) ? a.args : undefined,
              shellName: typeof a.shellName === "string" ? a.shellName : undefined,
            }));
          } else if (valid.length > 0) {
            console.warn(`[term] persisted instances partially invalid: ${arr.length - valid.length} discarded`);
          }
        }
      }
    } catch (e) {
      console.warn("[term] failed to load persisted instances", e);
    }
    // fresh: one terminal seeded
    const id = 1;
    const gen = 1;
    nextIdRef.current = 2;
    genCounterRef.current = 2;
    return [{ id, gen, title: `Terminal ${id}`, cwd: workspace ?? "", dead: false, err: "" }];
  });

  const [activeId, setActiveId] = useState<number>(() => {
    const raw = localStorage.getItem(ACTIVE_KEY) || "";
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
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

  // shell-switch menu: outside click + Escape closes, fetch profiles if needed
  useEffect(() => {
    if (!switchMenu) return;
    if (!profiles.length) void fetchTerminalProfiles().catch(() => {});
    const onDown = (e: Event) => {
      if (!switchMenuRef.current?.contains(e.target as Node)) setSwitchMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSwitchMenu(null); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [switchMenu, profiles.length]);

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
  // guard: only seed on open transition, not when last instance exits/killed while open
  // (otherwise exit on last term would re-create before onClose hides the panel)
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen && terms.length === 0) {
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
    } catch (e) {
      console.warn("[term] failed to persist instances (quota?)", e);
    }
  }, [terms]);
  useEffect(() => { localStorage.setItem(H_KEY, String(h)); }, [h]);

  const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

  const termsRef = useRef(terms);
  useEffect(() => { termsRef.current = terms; }, [terms]);

  const onTitle = useCallback((id: number, title: string) => {
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, title: title.slice(0, 80) } : t)));
  }, []);
  const onErr = useCallback((id: number, err: string) => {
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, err } : t)));
  }, []);
  const onExit = useCallback((id: number) => {
    setTerms((prev) => {
      const target = prev.find((t) => t.id === id);
      if (target) void invoke("pty_kill", { id, gen: target.gen }).catch(() => {});
      const idx = prev.findIndex((x) => x.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((x) => x.id !== id);
      if (next.length === 0) {
        setTimeout(() => onClose(), 0);
      } else if (activeId === id) {
        const newActive = next[Math.min(idx, next.length - 1)]?.id ?? next[0].id;
        setTimeout(() => setActiveId(newActive), 0);
      }
      playSound("close");
      return next;
    });
  }, [activeId, onClose]);
  const onDead = useCallback((id: number, dead: boolean) => {
    if (!dead) {
      setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, dead } : t)));
      return;
    }
    // any exited terminal instance should be closed — auto-remove instead of lingering as "exited"
    onExit(id);
  }, [onExit]);

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
    const t = termsRef.current.find((x) => x.id === id);
    if (!t) return;
    playSound("click");
    // kill old gen before bumping — view will spawn with new gen
    await invoke("pty_kill", { id, gen: t.gen }).catch(() => {});
    const newGen = genCounterRef.current++;
    setTerms((prev) => prev.map((x) => (x.id === id ? { ...x, gen: newGen, dead: false, err: "" } : x)));
  }, [resolveProfile]);

  const changeTermShell = useCallback(async (id: number, profileId: string | null) => {
    const t = termsRef.current.find((x) => x.id === id);
    if (!t) return;
    playSound("click");
    await invoke("pty_kill", { id, gen: t.gen }).catch(() => {});
    const resolved = resolveProfile(profileId);
    const newGen = genCounterRef.current++;
    setTerms((prev) => prev.map((x) => (x.id === id ? { ...x, gen: newGen, dead: false, err: "", shell: resolved?.path, args: resolved?.args, shellName: resolved?.name ?? (profileId ? undefined : "System default") } : x)));
  }, [resolveProfile]);

  const killTerm = useCallback(async (id: number) => {
    const t = termsRef.current.find((x) => x.id === id);
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
  }, [activeId, onClose]);

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

  // Ctrl+J → hide (when focused in terminal, focus chat) / reopen (when hidden)
  // Composer Ctrl+J toggles to terminal: if hidden opens, if open focuses.
  // Also suppresses the WebView2/Chromium native downloads popup (Ctrl+J) when
  // focus is NOT in an input/terminal — i.e. unfocused case.
  useEffect(() => {
    const focusTerminal = () => {
      // xterm helper textarea is the focusable element
      const helper = document.querySelector(".term-dock .xterm-helper-textarea") as HTMLElement | null;
      if (helper) { helper.focus(); return; }
      // fallback: dispatch to active TermInstanceView
      window.dispatchEvent(new CustomEvent("oc:term-focus"));
      // last resort: focus mount
      (document.querySelector(".term-dock .term-mount") as HTMLElement | null)?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      const ae = document.activeElement as HTMLElement | null;
      const inTerm = !!target?.closest?.(".term-dock") || !!ae?.closest?.(".term-dock");
      const inComposer = !!target?.closest?.(".composer") || !!ae?.closest?.(".composer");
      const inInput = !!target?.closest?.("input, textarea, [contenteditable=\"true\"], [contenteditable=\"\"]") || !!ae?.closest?.("input, textarea, [contenteditable=\"true\"], [contenteditable=\"\"]");
      const inEditable = inTerm || inInput;
      if (open) {
        if (inComposer) {
          // Composer → terminal toggle: focus terminal (keep open)
          e.preventDefault();
          e.stopPropagation();
          (e as any).stopImmediatePropagation?.();
          playSound("click");
          requestAnimationFrame(() => focusTerminal());
          return;
        }
        if (!inTerm) {
          // unfocused (not in terminal/composer): block native downloads.
          // Other inputs (e.g. file editor) stay untouched per "unfocused" wording.
          if (inEditable) return;
          e.preventDefault();
          e.stopPropagation();
          (e as any).stopImmediatePropagation?.();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        (e as any).stopImmediatePropagation?.();
        playSound("click");
        onClose();
        requestAnimationFrame(() => {
          (document.querySelector(".composer textarea") as HTMLElement | null)?.focus();
        });
      } else {
        // hidden → reopen from anywhere in the main/chat area (not an overlay)
        if (document.querySelector(".dlg-scrim, .drawer-scrim.open, .ctx-menu, .cmd-menu, .model-menu")) {
          e.preventDefault();
          e.stopPropagation();
          (e as any).stopImmediatePropagation?.();
          return;
        }
        if (inTerm) {
          e.preventDefault();
          e.stopPropagation();
          (e as any).stopImmediatePropagation?.();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        (e as any).stopImmediatePropagation?.();
        playSound("click");
        if (onToggle) onToggle();
        else (onClose as any)?.();
        // if triggered from composer, focus the newly opened terminal
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const helper = document.querySelector(".term-dock .xterm-helper-textarea") as HTMLElement | null;
            if (helper) helper.focus();
            else window.dispatchEvent(new CustomEvent("oc:term-focus"));
          });
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, onToggle]);

  return (
    <div className={`term-dock${open ? "" : " closed"}${dragging ? " dragging" : ""}${mounted ? "" : " no-anim"}`} style={{ height: open ? h : 0 }}>
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
              onExit={onExit}
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
                  setSwitchMenu({ id: t.id, x: e.clientX, y: e.clientY });
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
      {switchMenu && createPortal(
        <div
          ref={switchMenuRef}
          className="term-add-menu"
          style={{ position: "fixed", left: Math.min(switchMenu.x, window.innerWidth - 260), top: Math.min(switchMenu.y, window.innerHeight - 200), zIndex: 101, maxHeight: "min(360px, 60vh)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="term-add-group">Switch shell — Terminal {switchMenu.id}</div>
          <button className="term-add-item" onClick={() => { const id = switchMenu.id; setSwitchMenu(null); void changeTermShell(id, null); }}><i className="fa-solid fa-terminal" /> System default (PowerShell)</button>
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
                      <button key={p.id} className="term-add-item" onClick={() => { const id = switchMenu.id; const pid = p.id; setSwitchMenu(null); void changeTermShell(id, pid); }}><i className="fa-solid fa-terminal" /> {p.name}</button>
                    ))}
                  </>
                )}
                {groups.wsl.length > 0 && (
                  <>
                    <div className="term-add-group">WSL</div>
                    {groups.wsl.map((p) => (
                      <button key={p.id} className="term-add-item" onClick={() => { const id = switchMenu.id; const pid = p.id; setSwitchMenu(null); void changeTermShell(id, pid); }}><i className="fa-solid fa-cube" /> {p.name}</button>
                    ))}
                  </>
                )}
                {groups.wt.length > 0 && (
                  <>
                    <div className="term-add-group">Windows Terminal</div>
                    {groups.wt.map((p) => (
                      <button key={p.id} className="term-add-item" onClick={() => { const id = switchMenu.id; const pid = p.id; setSwitchMenu(null); void changeTermShell(id, pid); }}><i className="fa-solid fa-window-restore" /> {p.name}</button>
                    ))}
                  </>
                )}
                {customs.length > 0 && (
                  <>
                    <div className="term-add-group">Custom</div>
                    {customs.map((c) => (
                      <button key={c.id} className="term-add-item" onClick={() => { const id = switchMenu.id; const pid = c.id; setSwitchMenu(null); void changeTermShell(id, pid); }}><i className="fa-solid fa-wrench" /> {c.name}</button>
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
}
