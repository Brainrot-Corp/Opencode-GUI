import { useEffect, useRef, useState, useMemo, useCallback, useDeferredValue } from "react";
import type { Session } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
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
  activeId?: string;
  msgs?: Msg[];
  activeChildren?: Session[];
  childTaskCosts?: Record<string, { cost: number; tokens: number; title?: string }>;
};

const KEY = "oc.agentBoard.geom";
const OPEN_KEY = "oc.agentBoard.open";
const MIN_W = 460, MIN_H = 280, MAX_W = 900, MAX_H = 640;
const LANE_COUNT = 4;
const LOOP_MS = 10_000;

type Geom = { x: number; y: number; w: number; h: number };
function clamp(n: number, a: number, b: number) { return Math.min(Math.max(n, a), b); }
function defaultGeom(): Geom {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = clamp(MAX_W, MIN_W, vw - 12);
  const h = clamp(MAX_H, MIN_H, vh - 12);
  const x = clamp(Math.floor((vw - w) / 2), 0, Math.max(0, vw - w - 6));
  const y = clamp(Math.floor((vh - h) / 2 + 12), 0, Math.max(0, vh - h - 6));
  return { x, y, w, h };
}
function loadGeom(): Geom {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultGeom();
    const g = JSON.parse(raw);
    const vw = window.innerWidth, vh = window.innerHeight;
    const isMaxDefault = Number(g.w) === 620 && Number(g.h) === 380;
    if (isMaxDefault) return defaultGeom();
    return {
      x: clamp(Number(g.x) || 0, 0, Math.max(0, vw - MIN_W)),
      y: clamp(Number(g.y) || 0, 0, Math.max(0, vh - 80)),
      w: clamp(Number(g.w) || MAX_W, MIN_W, Math.min(MAX_W, vw - 12)),
      h: clamp(Number(g.h) || MAX_H, MIN_H, Math.min(MAX_H, vh - 12)),
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

export default function AgentBoard({ open, onClose, sessions, busyIds, compactingIds, attentionIds, agents, getDirForSession, onOpenSession, activeId, msgs, activeChildren, childTaskCosts }: Props) {
  const [geom, setGeom] = useState<Geom>(() => loadGeom());
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; g0: Geom } | null>(null);
  const resizeRef = useRef<{ dir: string; sx: number; sy: number; g0: Geom } | null>(null);
  const [simRunning, setSimRunning] = useState(false);
  const [nowMs, setNowMs] = useState(() => performance.now());
  const rafRef = useRef<number | null>(null);

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

  // Esc closes when open (no scrim — don't steal from other overlays).
  // onClose through a ref: ChatPage passes an inline arrow (new identity per
  // render = per streaming delta) — deps on it would resubscribe per delta.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        // if another overlay is open (dialog/drawer), let it handle Esc
        const overlay = document.querySelector(".dlg-scrim, .drawer-scrim.open, .ctx-menu, .cmd-menu, .model-menu");
        if (overlay) return;
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);

  // 60fps rAF ticker — smooth vs 12fps setInterval
  useEffect(() => {
    if (!open || !simRunning) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    loopBaseRef.current = performance.now();
    const loop = () => {
      setNowMs(performance.now());
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [open, simRunning]);

  // build simulated lane nodes — 4 default, each with staggered phase offset
  // gated on `open`: this runs on every streaming delta via msgs/sessions props,
  // and the board is usually closed — skip all scanning then
  const simNodes: SimNode[] = useMemo(() => {
    if (!open) return [];
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
  }, [open, agents, sessions, getDirForSession]);

  // per-node progress 0..1 over LOOP_MS with phase offset — driven by rAF
  const loopBaseRef = useRef<number>(performance.now());
  const loopElapsed = simRunning ? (nowMs - loopBaseRef.current) % LOOP_MS : 0;
  const progressFor = useCallback((node: SimNode): number => {
    const t = (loopElapsed / LOOP_MS + node.phase) % 1;
    return t;
  }, [loopElapsed]);

  // real background agents — busy/compacting/attention sessions
  const liveNodes = useMemo(() => {
    if (!open) return [];
    const set = new Set<string>();
    busyIds?.forEach(id => set.add(id));
    compactingIds?.forEach(id => set.add(id));
    attentionIds?.forEach(id => set.add(id));
    return [...set].map(id => sessions.find(s => s.id === id)).filter(Boolean) as Session[];
  }, [open, busyIds, compactingIds, attentionIds, sessions]);

  // --- sub-agent tasks (parentID child sessions + task tool parts) ---
  // user reported 3 parallel tasks not showing — they are child sessions with
  // parentID filtered from `sessions`, plus live tool parts with tool==="task"
  function fmtTok(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`; }
  // deferred: msgs churns per streaming delta and the scan below walks every
  // part (regexing large task outputs). useDeferredValue lets the streaming
  // render win and coalesces rescans — one per quiet frame, not one per delta
  const deferredMsgs = useDeferredValue(msgs);
  const taskLanes = useMemo(() => {
    type Lane = { id: string; label: string; details: string; status: SimStatus; agent: string; cost?: number; tokens?: number; duration?: string; rawId: string };
    const out: Lane[] = [];
    // closed board: skip the full-conversation part scan entirely — msgs churn
    // per streaming delta and this memo re-runs each time even when unmounted-
    // visible (hooks run before `if (!open) return null`)
    if (!open) return out;
    const seen = new Set<string>();
    // 1) live task tool parts from the active session's messages (most accurate: description + status)
    if (msgs && msgs.length) {
      for (const m of deferredMsgs as any[]) {
        for (const p of (m.parts ?? []) as any[]) {
          if (p?.type !== "tool") continue;
          if (String(p.tool ?? "").toLowerCase() !== "task") continue;
          const st = (p as any).state ?? {};
          const rawStatus = String(st.status ?? "running").toLowerCase();
          // only live tasks — completed tasks are historical, not background agents
          if (rawStatus === "completed" || rawStatus === "error" || rawStatus === "failed") continue;
          const pid = String(p.id ?? st.id ?? "");
          if (pid && seen.has(pid)) continue;
          if (pid) seen.add(pid);
          const desc = String(st.input?.description ?? st.input?.prompt ?? st.title ?? p.description ?? "task").trim() || "task";
          const agent = String(st.input?.subagentType ?? st.input?.agent ?? agents?.[0]?.name ?? "task");
          const ms = st.time?.start && st.time?.end ? st.time.end - st.time.start : null;
          const duration = ms != null ? (ms < 10000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms / 1000)}s`) : undefined;
          // cost lookup: try output ses_ id, then part id, then childTaskCosts direct
          let tid: string | null = null;
          try {
            const outTxt = String(st.output ?? "");
            const mm = outTxt.match(/ses_[a-zA-Z0-9_-]+/);
            tid = mm ? mm[0] : null;
          } catch {}
          const ci = (tid && childTaskCosts?.[tid]) || (pid && childTaskCosts?.[pid]) || null;
          const label = desc.length > 42 ? desc.slice(0, 42) + "…" : desc;
          const details = pid ? pid.slice(0, 8) : agent;
          out.push({ id: pid || tid || `task-${out.length}`, label, details, status: rawStatus === "pending" ? "queued" : "working", agent, cost: ci?.cost, tokens: ci?.tokens, duration, rawId: tid ?? pid ?? "" });
        }
      }
    }
    if (out.length) return out;
    // 2) fallback: child sessions of the active (busy) session — covers cases where tool parts not yet parsed
    if (activeId && busyIds?.has(activeId) && activeChildren && activeChildren.length) {
      for (const ch of activeChildren) {
        const id = (ch as any).id as string;
        if (seen.has(id)) continue;
        const ci = childTaskCosts?.[id];
        const title = (ch as any).title?.trim() ? String((ch as any).title) : ci?.title ?? id.slice(0, 8);
        const label = title.length > 42 ? title.slice(0, 42) + "…" : title;
        // heuristic: if cost/tokens present and parent still busy, treat as working; else done
        const status: SimStatus = "working";
        out.push({ id, label, details: id.slice(0, 8), status, agent: agents?.[0]?.name ?? "subagent", cost: ci?.cost ?? (ch as any).cost, tokens: ci?.tokens ?? ((ch as any).tokens ? ((ch as any).tokens.input ?? 0) + ((ch as any).tokens.output ?? 0) : undefined), duration: undefined, rawId: id });
      }
    }
    return out;
  }, [open, deferredMsgs, activeChildren, childTaskCosts, busyIds, activeId, agents]);

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
  }, [geom, open, simRunning, taskLanes.length]);
  // keep gridSize in sync on geom change (drag/resize commits) + task/sim switch
  useEffect(() => {
    if (!gridRef.current) return;
    setGridSize({ w: gridRef.current.clientWidth, h: gridRef.current.clientHeight });
  }, [geom.w, geom.h, simRunning, taskLanes.length]);

  const toggleSim = useCallback(() => {
    const next = !simRunning;
    setSimRunning(next);
    playSound(next ? "expand" : "collapse");
    if (next) {
      loopBaseRef.current = performance.now();
      setNowMs(performance.now());
    }
  }, [simRunning]);

  // derived node positions for graph overlay (pixel coords inside grid) — only when simulating
  const nodePos = useMemo(() => {
    if (!simRunning || !gridSize.w || !gridSize.h) return [] as { x: number; y: number; prog: number; status: SimStatus }[];
    const W = gridSize.w, H = gridSize.h;
    const pad = 6, gap = 6;
    const laneH = (H - 2 * pad - (LANE_COUNT - 1) * gap) / LANE_COUNT;
    const trackLeft = pad + 6; // 12
    const trackW = W - 2 * pad - 12; // W -24
    const blockW = 156;
    const avail = Math.max(0, trackW - blockW);
    return simNodes.map(n => {
      const prog = progressFor(n);
      const status = statusFor(prog);
      const laneTop = pad + n.lane * (laneH + gap);
      const cy = laneTop + laneH / 2;
      const cx = trackLeft + prog * avail + blockW / 2;
      return { x: cx, y: cy, prog, status };
    });
  }, [gridSize, simNodes, simRunning, loopElapsed, progressFor]);

  // positions for real tasks from the same parent — same grid, linked with animated edges
  const taskNodePos = useMemo(() => {
    if (simRunning || !gridSize.w || !gridSize.h || taskLanes.length === 0) return [] as { x: number; y: number; prog: number; status: SimStatus }[];
    const N = taskLanes.length;
    if (!N) return [];
    const W = gridSize.w, H = gridSize.h;
    const pad = 6, gap = 6;
    const laneH = (H - 2 * pad - (N - 1) * gap) / N;
    const trackLeft = pad + 6;
    const trackW = W - 2 * pad - 12;
    const blockW = 156;
    const avail = Math.max(0, trackW - blockW);
    return taskLanes.map((t, i) => {
      const prog = t.status === "queued" ? 0.18 : t.status === "done" ? 0.88 : 0.52;
      const laneTop = pad + i * (laneH + gap);
      const cy = laneTop + laneH / 2;
      const cx = trackLeft + prog * avail + blockW / 2;
      return { x: cx, y: cy, prog, status: t.status };
    });
  }, [gridSize, taskLanes, simRunning]);
  const taskEdges = useMemo(() => {
    const N = taskLanes.length;
    if (N < 2) return [] as [number, number][];
    // keep same DAG shape as sim when N matches, otherwise chain + fan-out
    const base = EDGES.filter(([a, b]) => a < N && b < N) as [number, number][];
    if (base.length) return base;
    const chain: [number, number][] = [];
    for (let i = 0; i < N - 1; i++) chain.push([i, i + 1]);
    if (N > 2) chain.push([0, 2]);
    return chain;
  }, [taskLanes, EDGES]);

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

  const taskCount = taskLanes.length;
  const liveCount = liveNodes.length;
  const totalBlocks = simRunning ? LANE_COUNT : (taskCount || liveCount);
  const showSim = simRunning;
  const showTask = !simRunning && taskCount > 0;
  const showLive = !simRunning && taskCount === 0 && liveCount > 0;
  const showEmpty = !simRunning && taskCount === 0 && liveCount === 0;

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
          <span className="agent-board-count" data-tip={simRunning ? `${totalBlocks} lanes · 10s loop` : taskCount ? `${taskCount} task${taskCount !== 1 ? "s" : ""}${liveCount ? ` · ${liveCount} session${liveCount !== 1 ? "s" : ""}` : " live"}` : `${liveCount} live`}>{simRunning ? `${totalBlocks} lanes` : taskCount ? `${taskCount} task${taskCount !== 1 ? "s" : ""}` : `${liveCount} live`}</span>
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
        {taskCount > 0 && !simRunning && (
          <div className="agent-live-row">
            <span className="agent-live-dot" aria-hidden />
            <span>{taskCount} task{taskCount !== 1 ? "s" : ""} running</span>
            <span style={{ color: "var(--text-faint)", textTransform: "none", letterSpacing: "0.02em" }}>
              {taskLanes.slice(0, 2).map(t => t.label).join(" · ")}
              {taskLanes.length > 2 ? ` +${taskLanes.length - 2}` : ""}
            </span>
            <span className="agent-live-count">{taskCount} active</span>
          </div>
        )}
        {liveNodes.length > 0 && taskCount === 0 && !simRunning && (
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

        {showSim ? (
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
                  const dx = Math.abs(tx - sx);
                  const dy = Math.abs(ty - sy);
                  const cOff = Math.min(64, Math.max(28, dx * 0.22 + dy * 0.12));
                  const c1x = sx + cOff, c1y = sy;
                  const c2x = tx - cOff, c2y = ty;
                  const d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
                  const st = s.status;
                  const cls = st === "done" ? "done" : st === "queued" ? "queued" : "working";
                  const marker = st === "done" ? "url(#ag-arr-done)" : st === "queued" ? "url(#ag-arr-queued)" : "url(#ag-arr)";
                  return <path key={idx} d={d} className={`agent-edge ${cls}`} markerEnd={marker} />;
                })}
              </svg>
            )}
            {simNodes.map(node => {
              const prog = progressFor(node);
              const status = statusFor(prog);
              const leftPct = Math.max(0, Math.min(1, prog));
              const barPct = status === "queued" ? Math.max(6, prog * 100) : status === "done" ? 100 : Math.round(prog * 100);
              const isRealLinked = sessions.some(s => s.id === node.sessionId);
              const avail = Math.max(0, (gridSize.w || 600) - 24 - 156);
              const leftPx = leftPct * avail;
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
                      style={{ transform: `translate3d(${leftPx}px,0,0)` }}
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
        ) : showTask ? (
          <div className="agent-grid agent-grid--live" ref={gridRef} role="list" aria-label="Running tasks">
            {gridSize.w > 0 && gridSize.h > 0 && taskNodePos.length === taskLanes.length && taskEdges.length > 0 && (
              <svg className="agent-edges" width={gridSize.w} height={gridSize.h} viewBox={`0 0 ${gridSize.w} ${gridSize.h}`} preserveAspectRatio="none" aria-hidden>
                <defs>
                  <marker id="ag-arr-task" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#7fd4d4" opacity={0.95} />
                  </marker>
                  <marker id="ag-arr-task-done" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#9fce8f" opacity={0.95} />
                  </marker>
                  <marker id="ag-arr-task-queued" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={6} markerHeight={6} orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#5b6c76" opacity={0.6} />
                  </marker>
                </defs>
                {taskEdges.map(([a, b], idx) => {
                  const s = taskNodePos[a], t = taskNodePos[b];
                  if (!s || !t) return null;
                  const sx = s.x, sy = s.y, tx = t.x, ty = t.y;
                  const dx = Math.abs(tx - sx), dy = Math.abs(ty - sy);
                  const cOff = Math.min(64, Math.max(28, dx * 0.22 + dy * 0.12));
                  const c1x = sx + cOff, c1y = sy;
                  const c2x = tx - cOff, c2y = ty;
                  const d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
                  const st = s.status;
                  const cls = st === "done" ? "done" : st === "queued" ? "queued" : "working";
                  const marker = st === "done" ? "url(#ag-arr-task-done)" : st === "queued" ? "url(#ag-arr-task-queued)" : "url(#ag-arr-task)";
                  return <path key={idx} d={d} className={`agent-edge ${cls}`} markerEnd={marker} />;
                })}
              </svg>
            )}
            {taskLanes.map((t, idx) => {
              const dir = activeId ? (getDirForSession?.(activeId) ?? "") : "";
              const pos = taskNodePos[idx];
              const prog = pos ? pos.prog : t.status === "queued" ? 0.18 : t.status === "done" ? 0.88 : 0.52;
              const avail = Math.max(0, (gridSize.w || 600) - 24 - 156);
              const leftPx = prog * avail;
              return (
                <div key={t.id} className="agent-lane" role="listitem" aria-label={`${t.label} — ${t.status}`}>
                  <div className="agent-lane-label" title={`${t.agent} · ${baseName(dir) || "workspace"}`}>
                    <i className="fa-solid fa-robot" />
                    <span>{t.agent}</span>
                    <span style={{ color: "var(--text-faint)", fontSize: 9, textTransform: "none", letterSpacing: "0.02em" }}>
                      · {baseName(dir) || "workspace"}
                    </span>
                  </div>
                  <div className="agent-lane-track">
                    <div
                      className={`agent-block ${t.status} real`}
                      style={{ transform: `translate3d(${leftPx}px,0,0)` }}
                      data-tip={`${t.label}${t.details ? ` · ${t.details}` : ""}${t.duration ? ` · ${t.duration}` : ""}${t.tokens ? ` · ${fmtTok(t.tokens)} tok` : ""}${t.cost ? ` · $${t.cost.toFixed(4)}` : ""}`}
                    >
                      <div className="agent-block-head">
                        <span className="agent-block-dot" aria-hidden />
                        <span className="agent-block-name" title={t.label}>{t.label}</span>
                        <span className="agent-block-status">{t.status}</span>
                      </div>
                      <div className="agent-block-session" title={t.details || t.rawId}>
                        <i className="fa-solid fa-diagram-project" />
                        <span>{t.details || t.rawId.slice(0, 8)}</span>
                        {t.duration && <span style={{ marginLeft: 6, color: "var(--text-faint)" }}>{t.duration}</span>}
                        {t.tokens ? <span style={{ marginLeft: 6, color: "var(--text-faint)" }}>{fmtTok(t.tokens)} tok</span> : null}
                        {t.cost ? <span style={{ marginLeft: 4, color: "var(--text-faint)" }}>${t.cost.toFixed(4)}</span> : null}
                      </div>
                      <i className="agent-block-bar" style={{ width: t.status === "working" ? "68%" : t.status === "queued" ? "28%" : "100%" }} aria-hidden />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : showLive ? (
          <div className="agent-grid agent-grid--live" role="list" aria-label="Live agents">
            {liveNodes.map(s => {
              const dir = getDirForSession?.(s.id) ?? "";
              const isBusy = !!busyIds?.has(s.id);
              const isCompact = !!compactingIds?.has(s.id);
              const isAttn = !!attentionIds?.has(s.id);
              const status: SimStatus = isBusy || isCompact ? "working" : isAttn ? "queued" : "working";
              const agentName = agents?.[0]?.name ?? "agent";
              return (
                <div key={s.id} className="agent-lane" role="listitem" aria-label={`${s.title || s.id} — ${status}`}>
                  <div className="agent-lane-label" title={`${agentName} · ${baseName(dir)}`}>
                    <i className="fa-solid fa-robot" />
                    <span>{agentName}</span>
                    <span style={{ color: "var(--text-faint)", fontSize: 9, textTransform: "none", letterSpacing: "0.02em" }}>
                      · {baseName(dir) || "workspace"}
                    </span>
                  </div>
                  <div className="agent-lane-track">
                    <div
                      className={`agent-block ${status} real`}
                      style={{ transform: "translate3d(0,0,0)" }}
                      data-tip={`${s.title || s.id}`}
                      onClick={() => { playSound("click"); onOpenSession?.(s.id); }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playSound("click"); onOpenSession?.(s.id); } }}
                    >
                      <div className="agent-block-head">
                        <span className="agent-block-dot" aria-hidden />
                        <span className="agent-block-name" title={s.title || s.id}>{s.title || s.id.slice(0, 12)}</span>
                        <span className="agent-block-status">{status}</span>
                      </div>
                      <div className="agent-block-session" title={dir || s.id}>
                        <i className="fa-solid fa-link" />
                        <span>{dir ? baseName(dir) + " · " : ""}{s.id.slice(0, 8)}</span>
                      </div>
                      <i className="agent-block-bar" style={{ width: status === "working" ? "62%" : "28%" }} aria-hidden />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : showEmpty ? (
          <div className="agent-empty">
            <i className="fa-solid fa-circle-nodes" />
            <span>No background agents</span>
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>Busy sessions appear here — or click Simulate to preview the 10s pipeline</span>
          </div>
        ) : null}
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
