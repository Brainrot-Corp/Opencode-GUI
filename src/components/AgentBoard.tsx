import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { Session } from "@opencode-ai/sdk/client";
import { playSound } from "../lib/sounds";
import "../styles/agent-board.css";

type Props = {
  open: boolean;
  onClose: () => void;
  sessions: Session[];
  busyIds?: Set<string>;
  compactingIds?: Set<string>;
  attentionIds?: Set<string>;
  agents?: { name: string; mode: string }[];
  getDirForSession?: (id: string) => string;
  onOpenSession?: (id: string) => void;
};

const KEY = "oc.agentBoard.geom";
const OPEN_KEY = "oc.agentBoard.open";
const MIN_W = 460, MIN_H = 280, MAX_W = 900, MAX_H = 640;
const LANE_COUNT = 4;
const LOOP_MS = 10_000;

type Geom = { x: number; y: number; w: number; h: number };
function clamp(n: number, a: number, b: number) { return Math.min(Math.max(n, a), b); }
function defaultGeom(): Geom {
  const w = 620, h = 380;
  const x = Math.max(12, Math.floor((window.innerWidth - w) / 2 + 80));
  const y = Math.max(42 + 12, Math.floor((window.innerHeight - h) / 2 - 10));
  return { x, y, w, h };
}
function loadGeom(): Geom {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultGeom();
    const g = JSON.parse(raw);
    const vw = window.innerWidth, vh = window.innerHeight;
    return {
      x: clamp(Number(g.x) || 0, 0, Math.max(0, vw - MIN_W)),
      y: clamp(Number(g.y) || 0, 0, Math.max(0, vh - 80)),
      w: clamp(Number(g.w) || 620, MIN_W, Math.min(MAX_W, vw - 12)),
      h: clamp(Number(g.h) || 380, MIN_H, Math.min(MAX_H, vh - 12)),
    };
  } catch { return defaultGeom(); }
}
function saveGeom(g: Geom) {
  try { localStorage.setItem(KEY, JSON.stringify(g)); } catch {}
}

type SimStatus = "queued" | "working" | "done";
type SimNode = {
  id: string;
  lane: number;
  name: string;
  sessionId: string;
  sessionTitle: string;
  dirLabel: string;
  color: string;
  phase: number; // 0..1 offset
};

function baseName(p: string): string {
  if (!p) return "Server cwd";
  const t = p.replace(/[\/\\]+$/, "");
  const idx = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return idx >= 0 ? t.slice(idx + 1) : t;
}

function statusFor(progress: number): SimStatus {
  if (progress < 0.12) return "queued";
  if (progress < 0.88) return "working";
  return "done";
}

export default function AgentBoard({ open, onClose, sessions, busyIds, compactingIds, attentionIds, agents, getDirForSession, onOpenSession }: Props) {
  const [geom, setGeom] = useState<Geom>(() => loadGeom());
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; g0: Geom } | null>(null);
  const resizeRef = useRef<{ dir: string; sx: number; sy: number; g0: Geom } | null>(null);
  const [simRunning, setSimRunning] = useState(false);
  const [tick, setTick] = useState(0);

  // keep geom clamped on viewport resize
  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      setGeom(g => {
        const nx = clamp(g.x, 0, Math.max(0, vw - MIN_W));
        const ny = clamp(g.y, 0, Math.max(0, vh - MIN_H));
        const nw = clamp(g.w, MIN_W, Math.min(MAX_W, vw - 12));
        const nh = clamp(g.h, MIN_H, Math.min(MAX_H, vh - 12));
        if (nx === g.x && ny === g.y && nw === g.w && nh === g.h) return g;
        const next = { x: nx, y: ny, w: nw, h: nh };
        saveGeom(next);
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // persist open state
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
  }, [open]);

  // Esc closes when open (no scrim — don't steal from other overlays)
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        // if another overlay is open (dialog/drawer), let it handle Esc
        const overlay = document.querySelector(".dlg-scrim, .drawer-scrim.open, .ctx-menu, .cmd-menu, .model-menu");
        if (overlay) return;
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);

  // 10s loop ticker
  useEffect(() => {
    if (!simRunning) return;
    const id = window.setInterval(() => setTick(t => t + 1), 80);
    return () => clearInterval(id);
  }, [simRunning]);

  // build simulated lane nodes — 4 default, each with staggered phase offset
  const simNodes: SimNode[] = useMemo(() => {
    const names = (agents && agents.length ? agents.slice(0, 4).map(a => a.name) : ["explore", "plan", "build", "general"]);
    // pad to 4
    while (names.length < 4) names.push(`agent-${names.length + 1}`);
    const pool = sessions.length ? sessions : [];
    return Array.from({ length: LANE_COUNT }, (_, i) => {
      const pick = pool.length ? pool[(i * 7) % pool.length] : null;
      const sid = pick?.id ?? `sim-sess-${i}`;
      const title = pick?.title?.trim() ? pick.title : `Session ${String.fromCharCode(65 + i)} · ${baseName(getDirForSession?.(pick?.id ?? "") ?? "") || "workspace"}`;
      const dir = getDirForSession?.(pick?.id ?? "") ?? "";
      return {
        id: `sim-${i}`,
        lane: i,
        name: names[i],
        sessionId: sid,
        sessionTitle: title,
        dirLabel: baseName(dir),
        color: `hsl(${180 + i * 18} 55% 60%)`,
        phase: (i * 0.24) % 1, // stagger lanes
      };
    });
  }, [agents, sessions, getDirForSession]);

  // compute per-node progress 0..1 over LOOP_MS with phase offset
  const now = useMemo(() => Date.now(), [tick, simRunning]);
  // anchor loop to mount so phases are stable; but tick drives progress
  const loopBaseRef = useRef<number>(Date.now());
  useEffect(() => { if (simRunning) loopBaseRef.current = Date.now(); }, [simRunning]);
  const loopElapsed = simRunning ? (now - loopBaseRef.current) % LOOP_MS : 0;
  function progressFor(node: SimNode): number {
    if (!simRunning) {
      // when idle, show staged preview — small working chunk
      const staged = [0.18, 0.42, 0.66, 0.08];
      return staged[node.lane] ?? 0.3;
    }
    const t = (loopElapsed / LOOP_MS + node.phase) % 1;
    return t;
  }

  // real background agents — busy/compacting/attention sessions
  const liveNodes = useMemo(() => {
    const set = new Set<string>();
    busyIds?.forEach(id => set.add(id));
    compactingIds?.forEach(id => set.add(id));
    attentionIds?.forEach(id => set.add(id));
    return [...set].map(id => sessions.find(s => s.id === id)).filter(Boolean) as Session[];
  }, [busyIds, compactingIds, attentionIds, sessions]);

  // graph edges — DAG across lanes
  const EDGES: [number, number][] = useMemo(() => [[0,1],[1,2],[2,3],[0,2],[1,3]], []);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGridSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setGridSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [geom, open]);
  // keep gridSize in sync on geom change (drag/resize commits)
  useEffect(() => {
    if (!gridRef.current) return;
    setGridSize({ w: gridRef.current.clientWidth, h: gridRef.current.clientHeight });
  }, [geom.w, geom.h]);

  const toggleSim = useCallback(() => {
    const next = !simRunning;
    setSimRunning(next);
    playSound(next ? "expand" : "collapse");
    if (next) {
      loopBaseRef.current = Date.now();
      setTick(t => t + 1);
    }
  }, [simRunning]);

  // derived node positions for graph overlay (pixel coords inside grid)
  const nodePos = useMemo(() => {
    if (!gridSize.w || !gridSize.h) return [] as { x: number; y: number; prog: number; status: SimStatus }[];
    const W = gridSize.w, H = gridSize.h;
    const pad = 6, gap = 6;
    const laneH = (H - 2 * pad - (LANE_COUNT - 1) * gap) / LANE_COUNT;
    // track inset: lane has 6px pad left/right, track width = laneW -12
    // gridW - 2*pad = laneW
    const trackLeft = pad + 6; // 12
    const trackW = W - 2 * pad - 12; // W -24
    const blockW = 156;
    const avail = Math.max(0, trackW - blockW);
    return simNodes.map(n => {
      const prog = progressFor(n);
      const status = simRunning ? statusFor(prog) : ("working" as SimStatus);
      const laneTop = pad + n.lane * (laneH + gap);
      const cy = laneTop + laneH / 2;
      const cx = trackLeft + prog * avail + blockW / 2;
      return { x: cx, y: cy, prog, status };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridSize, simNodes, tick, simRunning, loopElapsed]);

  // drag header — direct DOM at 60fps, commit on mouseup
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    e.preventDefault();
    const el = panelRef.current;
    if (!el) return;
    const startX = e.clientX, startY = e.clientY;
    const g0 = { ...geom };
    dragRef.current = { startX, startY, g0 };
    document.body.style.userSelect = "none";
    let raf = 0;
    let last = { x: g0.x, y: g0.y };
    const flush = () => {
      raf = 0;
      el.style.left = last.x + "px";
      el.style.top = last.y + "px";
    };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      last.x = clamp(d.g0.x + (ev.clientX - d.startX), 0, Math.max(0, window.innerWidth - g0.w));
      last.y = clamp(d.g0.y + (ev.clientY - d.startY), 0, Math.max(0, window.innerHeight - 80));
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      el.style.left = last.x + "px";
      el.style.top = last.y + "px";
      setGeom(s => {
        if (s.x === last.x && s.y === last.y) return s;
        const next = { ...s, x: last.x, y: last.y };
        saveGeom(next);
        return next;
      });
      dragRef.current = null;
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [geom]);

  const onResizeStart = useCallback((dir: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const el = panelRef.current;
    if (!el) return;
    const sx = e.clientX, sy = e.clientY;
    const g0 = { ...geom };
    resizeRef.current = { dir, sx, sy, g0 };
    document.body.style.userSelect = "none";
    let raf = 0;
    let last = { ...g0 };
    const flush = () => {
      raf = 0;
      el.style.left = last.x + "px";
      el.style.top = last.y + "px";
      el.style.width = last.w + "px";
      el.style.height = last.h + "px";
    };
    const move = (ev: MouseEvent) => {
      const r = resizeRef.current; if (!r) return;
      let { x, y, w, h } = r.g0;
      const dx = ev.clientX - r.sx, dy = ev.clientY - r.sy;
      if (r.dir.includes("e")) w = clamp(g0.w + dx, MIN_W, Math.min(MAX_W, window.innerWidth - x - 6));
      if (r.dir.includes("s")) h = clamp(g0.h + dy, MIN_H, Math.min(MAX_H, window.innerHeight - y - 6));
      if (r.dir.includes("w")) { const nw = clamp(g0.w - dx, MIN_W, g0.x + g0.w); x = g0.x + g0.w - nw; w = nw; x = clamp(x, 0, window.innerWidth - MIN_W); }
      if (r.dir.includes("n")) { const nh = clamp(g0.h - dy, MIN_H, g0.y + g0.h); y = g0.y + g0.h - nh; h = nh; y = clamp(y, 0, window.innerHeight - MIN_H); }
      last = { x, y, w, h };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      el.style.left = last.x + "px";
      el.style.top = last.y + "px";
      el.style.width = last.w + "px";
      el.style.height = last.h + "px";
      setGeom(s => {
        if (s.w === last.w && s.h === last.h && s.x === last.x && s.y === last.y) return s;
        saveGeom(last);
        return last;
      });
      resizeRef.current = null;
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [geom]);

  if (!open) return null;

  const totalBlocks = LANE_COUNT;

  return (
    <div
      ref={panelRef}
      className="agent-board"
      style={{ left: geom.x + "px", top: geom.y + "px", width: geom.w + "px", height: geom.h + "px" }}
      role="dialog"
      aria-label="Agents"
      onMouseDown={e => { if ((e.target as HTMLElement).closest("button, input, textarea")) return; }}
    >
      <div className="agent-board-head" onMouseDown={onDragStart}>
        <span className="agent-board-title">
          <i className="fa-solid fa-diagram-project" />
          Agents
          <span className="agent-board-count" data-tip={`${totalBlocks} lanes · 10s loop`}>{totalBlocks} lanes</span>
        </span>
        <div className="agent-board-actions">
          <button
            className={`agent-sim-btn${simRunning ? " on" : ""}`}
            onClick={toggleSim}
            data-tip={simRunning ? "Stop simulation (10s loop)" : "Simulate: start → working → done (10s loop)"}
          >
            <i className={`fa-solid ${simRunning ? "fa-stop" : "fa-play"}`} />
            {simRunning ? "Stop sim" : "Simulate"}
          </button>
          <button className="icon-btn" data-tip="Close (Esc / Alt+A)" onClick={onClose} aria-label="Close">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
      </div>

      <div className="agent-board-body">
        {liveNodes.length > 0 && (
          <div className="agent-live-row">
            <span className="agent-live-dot" aria-hidden />
            <span>{liveNodes.length} live</span>
            <span style={{ color: "var(--text-faint)", textTransform: "none", letterSpacing: "0.02em" }}>
              {liveNodes.slice(0, 2).map(s => s.title || s.id.slice(0, 6)).join(" · ")}
              {liveNodes.length > 2 ? ` +${liveNodes.length - 2}` : ""}
            </span>
            <span className="agent-live-count">{liveNodes.length} busy</span>
          </div>
        )}

        <div className="agent-grid" ref={gridRef} role="list" aria-label="Agent lanes">
          {/* graph edges — DAG behind lanes, animated dash for working flows */}
          {gridSize.w > 0 && gridSize.h > 0 && nodePos.length === LANE_COUNT && (
            <svg className="agent-edges" width={gridSize.w} height={gridSize.h} viewBox={`0 0 ${gridSize.w} ${gridSize.h}`} preserveAspectRatio="none" aria-hidden>
              <defs>
                <marker id="ag-arr" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
                  <path d="M0,0 L6,3 L0,6 z" fill="#7fd4d4" opacity={0.95} />
                </marker>
                <marker id="ag-arr-done" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
                  <path d="M0,0 L6,3 L0,6 z" fill="#9fce8f" opacity={0.95} />
                </marker>
                <marker id="ag-arr-queued" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
                  <path d="M0,0 L6,3 L0,6 z" fill="#5b6c76" opacity={0.6} />
                </marker>
              </defs>
              {EDGES.map(([a, b], idx) => {
                const s = nodePos[a], t = nodePos[b];
                if (!s || !t) return null;
                const sx = s.x, sy = s.y, tx = t.x, ty = t.y;
                // control offset scales with lane distance and horizontal gap
                const dx = Math.abs(tx - sx);
                const dy = Math.abs(ty - sy);
                const cOff = Math.min(64, Math.max(28, dx * 0.22 + dy * 0.12));
                // direction-aware controls: bend outward
                const c1x = sx + cOff, c1y = sy;
                const c2x = tx - cOff, c2y = ty;
                const d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
                // edge status derived from source node (pipeline flow)
                const st = s.status;
                const cls = st === "done" ? "done" : st === "queued" ? "queued" : "working";
                const marker = st === "done" ? "url(#ag-arr-done)" : st === "queued" ? "url(#ag-arr-queued)" : "url(#ag-arr)";
                return <path key={idx} d={d} className={`agent-edge ${cls}`} markerEnd={marker} />;
              })}
            </svg>
          )}
          {simNodes.map(node => {
            const prog = progressFor(node);
            const status = simRunning ? statusFor(prog) : ("working" as SimStatus);
            const leftPct = Math.max(0, Math.min(1, prog));
            const barPct = status === "queued" ? Math.max(6, prog * 100) : status === "done" ? 100 : Math.round(prog * 100);
            const isRealLinked = sessions.some(s => s.id === node.sessionId);
            return (
              <div key={node.id} className="agent-lane" role="listitem" aria-label={`${node.name} — ${status}`}>
                <div className="agent-lane-label" title={`${node.name} · ${node.dirLabel || "workspace"}`}>
                  <i className="fa-solid fa-robot" />
                  <span>{node.name}</span>
                  <span style={{ color: "var(--text-faint)", fontSize: 9, textTransform: "none", letterSpacing: "0.02em" }}>
                    · {node.dirLabel || "workspace"}
                  </span>
                </div>
                <div className="agent-lane-track">
                  <div
                    className={`agent-block ${status}${isRealLinked ? " real" : ""}`}
                    style={{ left: `calc(${leftPct * 100}% - ${leftPct * 156}px)` }}
                    data-tip={`${node.name} → ${node.sessionTitle}`}
                    onClick={() => {
                      if (isRealLinked && onOpenSession) {
                        playSound("click");
                        onOpenSession(node.sessionId);
                      }
                    }}
                    role={isRealLinked ? "button" : undefined}
                    tabIndex={isRealLinked ? 0 : -1}
                    onKeyDown={e => {
                      if (!isRealLinked || !onOpenSession) return;
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playSound("click"); onOpenSession(node.sessionId); }
                    }}
                  >
                    <div className="agent-block-head">
                      <span className="agent-block-dot" aria-hidden />
                      <span className="agent-block-name">{node.name}</span>
                      <span className="agent-block-status">{status}</span>
                    </div>
                    <div className="agent-block-session" title={node.sessionTitle}>
                      <i className="fa-solid fa-link" />
                      <span>{node.sessionTitle}</span>
                    </div>
                    <i className="agent-block-bar" style={{ width: `${barPct}%` }} aria-hidden />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {!sessions.length && !simRunning && (
          <div className="agent-empty">
            <i className="fa-solid fa-circle-nodes" />
            <span>No sessions yet — simulation uses placeholder links</span>
          </div>
        )}
      </div>

      <div className="agent-handle n" onMouseDown={onResizeStart("n")} />
      <div className="agent-handle s" onMouseDown={onResizeStart("s")} />
      <div className="agent-handle e" onMouseDown={onResizeStart("e")} />
      <div className="agent-handle w" onMouseDown={onResizeStart("w")} />
      <div className="agent-handle nw" onMouseDown={onResizeStart("nw")} />
      <div className="agent-handle ne" onMouseDown={onResizeStart("ne")} />
      <div className="agent-handle sw" onMouseDown={onResizeStart("sw")} />
      <div className="agent-handle se" onMouseDown={onResizeStart("se")} />
    </div>
  );
}
