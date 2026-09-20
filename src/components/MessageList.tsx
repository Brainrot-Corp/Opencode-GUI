import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import { iconFor } from "../lib/attachments";
import { loadMonaco } from "../lib/monaco";
import { parseAnsweredSummary } from "../lib/qSummary";
import ToolBlock, { PartCtx } from "./ToolBlock";
import Lightbox from "./Lightbox";
import AnsweredSummary from "./parts/AnsweredSummary";
import Reasoning, { STREAM_RAW_LIMIT } from "./parts/Reasoning";
import { extractTaskEntries, SubtaskBlock, TaskMixed } from "./parts/TaskBlocks";
import { mdComponents } from "./parts/mdParts";
import "../styles/chat.css";
import "../styles/find.css";

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} ${time}`;
}

function fmtFull(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" } as any);
}

// does this part produce visible output? — single source shared by
// renderPart's early return and rowVisible's row-skip so the two can't drift
function partVisible(p: any): boolean {
  switch (p.type) {
    case "text":
      return !!(p.text ?? "").trim();
    case "file":
      return true;
    case "step-finish": {
      const tk = p.tokens ?? {};
      return !!((tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0)) || !!p.cost;
    }
    case "patch":
      return !!(p.files ?? []).length;
    default:
      return ["reasoning", "tool", "retry", "compaction", "agent", "subtask"].includes(p.type);
  }
}

function fmtTok(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

// reasoning part — /collapse default resolved from the shared PartCtx here
// so Reasoning's own prop contract stays untouched
function ReasoningPart({ part, streaming }: { part: Part; streaming?: boolean }) {
  const { collapsedDefault } = useContext(PartCtx);
  return <Reasoning part={part} defaultOpen={!collapsedDefault} streaming={streaming} />;
}

function renderPart(
  part: Part,
  key: number,
  onImage?: (url: string) => void,
  streaming?: boolean,
) {
  if (!partVisible(part)) return null;
  const idKey = (part as any).id || key;
  switch (part.type) {
    case "text": {
      const t = (part as any).text ?? "";
      // a still-growing giant document re-parses markdown + highlight every
      // delta — swap to plain text past the cap (final markdown renders once
      // the message completes)
      if (streaming && t.length > STREAM_RAW_LIMIT) {
        return (
          <pre key={key} className="stream-raw">
            {t}
          </pre>
        );
      }
      if (parseAnsweredSummary(t)) return <AnsweredSummary key={key} text={t} />;
      // agent final reports land as fenced <task> XML — render them in the
      // same collapsible tool-block chrome instead of raw code dump
      if (/<task\b/i.test(t) && extractTaskEntries(t)) {
        return <TaskMixed key={key} text={t} />;
      }
      return (
        <Markdown key={key} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
          {t}
        </Markdown>
      );
    }
    case "reasoning":
      return <ReasoningPart key={idKey} part={part} streaming={streaming} />;
    case "tool":
      return <ToolBlock key={idKey} part={part} />;
    case "step-finish": {
      const sf = part as any;
      const tk = sf.tokens ?? {};
      const total = (tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0);
      return (
        <div key={key} className="part-note mono">
          <i className="fa-solid fa-shoe-prints" />
          step · {fmtTok(total)} tok
          {sf.cost > 0 && ` · $${sf.cost.toFixed(4)}`}
        </div>
      );
    }
    case "retry": {
      const r = part as any;
      return (
        <div key={key} className="part-note retry mono">
          <i className="fa-solid fa-rotate-right" />
          retrying (attempt {r.attempt})
          {r.error?.message ? ` — ${r.error.message}` : ""}
        </div>
      );
    }
    case "compaction": {
      const c = part as any;
      return (
        <div key={key} className="part-note mono">
          <i className="fa-solid fa-compress" />
          context compacted{c.auto ? "" : " (manual)"}
        </div>
      );
    }
    case "patch": {
      const pt = part as any;
      const files: string[] = pt.files ?? [];
      return (
        <div key={key} className="patch-line">
          <i className="fa-solid fa-code-pull-request" />
          changed:
          {files.map((f) => (
            <span key={f} className="mono patch-file" data-tip={f}>
              {f.split(/[\\/]/).pop()}
            </span>
          ))}
        </div>
      );
    }
    case "agent":
    case "subtask":
      return <SubtaskBlock key={idKey} part={part as any} />;
    case "file": {
      const f = part as any;
      const url: string = f.url ?? "";
      const mime: string = f.mime ?? "";
      const name = f.filename || "file";
      if (mime.startsWith("image/") && url)
        return (
          <img
            key={key}
            className="file-img"
            src={url}
            alt={name}
            loading="lazy"
            data-tip="Click to expand"
            onClick={() => onImage?.(url)}
          />
        );
      if (mime.startsWith("video/") && url)
        return <video key={key} className="file-video" src={url} controls preload="metadata" />;
      return (
        <div key={key} className="file-chip mono">
          <i className={`fa-solid ${iconFor(mime)}`} />
          {name}
        </div>
      );
    }
    default:
      return null;
  }
}

// human-readable text from a NamedError-shaped message error
function errText(err: any): string {
  return err?.data?.message || err?.message || err?.name || "unknown error";
}

// cheap row-visibility check — shares partVisible with renderPart's null
// branches, so a rendered-but-empty row and a skipped row can never drift
// apart (the old .some(renderPart(…)) rendered every message on every pass
// just to decide what to skip)
function rowVisible(m: Msg): boolean {
  if (m.info.role === "user") return true;
  const err = m.info.role === "assistant" ? (m.info as any).error : null;
  if (err && err.name !== "MessageAbortedError") return true;
  return m.parts.some((p: any) => partVisible(p));
}

// history rows beyond the initial tail mount as a 44px skeleton and upgrade to
// real content only once they near the viewport — prepending a big batch stays
// a cheap frame (no markdown/highlight/monaco work for rows nobody sees yet).
// Upgrades above the viewport change the row's height, so onShift lets the
// list shift scrollTop by the delta and keep the reader's view anchored.
// One memoized component: a streaming delta swaps only the touched message's
// identity, so this memo re-renders ONE row per frame instead of every row
// in the tail window (the old LazyRow wrapper was not memoized).
const LazyMsgRow = memo(function LazyMsgRow({
  m,
  eager,
  onShift,
  onRevert,
  onFork,
  onImage,
  readOnly,
}: {
  m: Msg;
  eager: boolean;
  onShift: (dh: number, el: HTMLDivElement) => void;
  onRevert?: (messageID: string) => void;
  onFork?: (messageID: string) => void;
  onImage?: (url: string) => void;
  readOnly?: boolean;
}) {
  const [on, setOn] = useState(eager);
  const ref = useRef<HTMLDivElement>(null);
  const prevH = useRef(0);
  const startedEager = useRef(eager);
  useEffect(() => {
    if (on) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        prevH.current = el.offsetHeight;
        setOn(true);
        io.disconnect();
      },
      // upgrade ahead of the viewport so real content is ready on arrival
      { rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  useLayoutEffect(() => {
    if (!on || startedEager.current) return;
    const el = ref.current;
    if (!el) return;
    const dh = el.offsetHeight - prevH.current;
    if (dh !== 0) onShift(dh, el);
  }, [on]);

  const err = m.info.role === "assistant" ? (m.info as any).error : null;
  const showErr = err && err.name !== "MessageAbortedError";
  const isCmd = !!(m as any)._isCommand;
  const isQueued = !!(m as any)._isQueued;
  const rawTs = (m.info as any).time?.completed ?? (m.info as any).time?.created;
  const streaming = m.info.role === "assistant" && !(m.info as any).time?.completed;
  const short = fmtTime(rawTs);
  const full = fmtFull(rawTs);
  return (
    <div ref={ref} className="lzy-row" data-mid={m.info.id}>
      {on ? (
        <div className={`msg ${m.info.role}${showErr ? " msg-error" : ""}${isCmd ? " msg-command" : ""}${isQueued ? " msg-queued" : ""}`}>
          {m.info.role === "user" && !isCmd && !isQueued && !readOnly && (onRevert || onFork) && (
            <span className="msg-actions">
              {onFork && (
                <button
                  className="fork"
                  data-tip="Fork conversation from here"
                  onClick={() => onFork(m.info.id)}
                >
                  <i className="fa-solid fa-code-branch" />
                </button>
              )}
              {onRevert && (
                <button
                  className="rewind"
                  data-tip="Rewind conversation to here"
                  onClick={() => onRevert(m.info.id)}
                >
                  <i className="fa-solid fa-clock-rotate-left" />
                </button>
              )}
            </span>
          )}
          {showErr && (
            <div className="msg-err-line">
              <i className="fa-solid fa-triangle-exclamation" />
              <span>{errText(err)}</span>
            </div>
          )}
          {m.parts.map((part, i) => renderPart(part, i, onImage, streaming))}
          {short && (
            <div className="msg-time" data-tip={full} data-tip-cursor="">
              <i className="fa-solid fa-clock" />
              {short}
              {isCmd && <span className="msg-cmd-label">· command not sent</span>}
              {isQueued && <span className="msg-cmd-label">· queued</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="msg skel" />
      )}
    </div>
  );
});

// tail window: huge histories mount only the newest N messages as real
// content; older rows come in as cheap LazyMsgRow skeletons. The window
// SLIDES both directions — rows evicted at the far end unmount, so browsing
// the top of a 20k session keeps the DOM and RAM bounded (unload up/down).
// Batches are a fixed size and paced: triggers that arrive inside the pause
// are DROPPED, never buffered — middle-click autoscroll can't queue a runaway
// load chain, it gets one portion per pause while a sentinel stays in reach.
const TAIL_FIRST = 50;
const WIN_STEP = 50;
const MAX_WIN = 600;
const LOAD_PAUSE_MS = 100;

export default function MessageList({
  msgs,
  busy,
  compacting,
  loading,
  collapsed,
  onRevert,
  onFork,
  sessionId,
  findOpen,
  findQuery,
  findCase,
  findCur,
  findHits,
  onFindHits,
  onFindQueryChange,
  onFindCaseToggle,
  onFindClose,
  onFindNext,
  onFindPrev,
  taskCosts,
  dir,
  readOnly,
  onOpenSubagent,
}: {
  msgs: Msg[];
  busy: boolean;
  compacting?: boolean;
  loading?: boolean;
  // global /collapse default for thinking + tool blocks
  collapsed?: boolean;
  onRevert?: (messageID: string) => void;
  onFork?: (messageID: string) => void;
  sessionId?: string;
  findOpen?: boolean;
  findQuery?: string;
  findCase?: boolean;
  findCur?: number;
  findHits?: number;
  onFindHits?: (n: number) => void;
  onFindQueryChange?: (v: string) => void;
  onFindCaseToggle?: () => void;
  onFindClose?: () => void;
  onFindNext?: () => void;
  onFindPrev?: () => void;
  taskCosts?: Record<string, { cost: number; tokens: number }>;
  dir?: string;
  readOnly?: boolean;
  onOpenSubagent?: (id: string | null, part?: any) => void;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  // per-part render config distributed via PartCtx (see ToolBlock) instead of
  // drilling through LazyMsgRow/renderPart; memoized so streaming re-renders
  // keep the same identity and don't fan out to context consumers
  const partCtx = useMemo(
    () => ({ collapsedDefault: collapsed, taskCosts, dir, onOpenSubagent }),
    [collapsed, taskCosts, dir, onOpenSubagent],
  );

  const chatFindInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (findOpen) requestAnimationFrame(() => chatFindInputRef.current?.select());
  }, [findOpen]);

  // warm the monaco chunk while idle — scrolled-to code blocks then upgrade
  // instantly instead of fetching+compiling the editor on first sight
  useEffect(() => {
    let dead = false;
    const warm = () => {
      if (!dead) void loadMonaco().catch(() => {});
    };
    const ric = (window as any).requestIdleCallback;
    if (typeof ric === "function") {
      const id = ric.call(window, warm, { timeout: 3000 });
      return () => {
        dead = true;
        (window as any).cancelIdleCallback?.call(window, id);
      };
    }
    const t = window.setTimeout(warm, 1500);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, []);

  const listRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // last scrollTop we set ourselves — lets the scroll listener tell our own
  // programmatic scrolls (snap / queued re-pin) apart from the user's
  const expected = useRef(0);
  // "session:head-message" signature of the last render — a change means
  // content was replaced (switch/fill), not streamed onto
  const lastSig = useRef<string | undefined>(undefined);
  // boot fill arrives as skeletons-then-content — landing needs the
  // loading→ready flip too, not just the head-message signature
  const wasLoading = useRef(false);
  // stream end while pinned — late layout (monaco editors, images) grows
  // content after the last snap, so land exactly instead of hovering
  const wasBusy = useRef(false);
  // pinned = reader is at the exact tail: follow every growth until they
  // scroll away (any distance). only real user input moves the pin —
  // content growth alone can never unpin, and an unpinned reader is never
  // moved by the app
  const stick = useRef(true);
  // tail message id at the previous render — detects an outgoing message
  const lastTail = useRef<string | undefined>(undefined);
  // bottom scrolled out of view → show the floating "back to tail" pill
  const [showJump, setShowJump] = useState(false);

  // sliding history window [winStart, winEnd) into msgs — the tail mounts on
  // open; older/newer batches slide it on demand and rows outside unmount
  // (unload both directions). Set together in one commit so anchor
  // compensation measures exactly one window move.
  const [winStart, setWinStart] = useState(0);
  const [winEnd, setWinEnd] = useState(0);
  const setWin = useCallback((start: number, end: number) => {
    setWinStart(start);
    setWinEnd(end);
  }, []);
  useEffect(() => {
    // session switch / boot: park the window on the tail
    const start = Math.max(0, msgs.length - TAIL_FIRST);
    winRef.current = { start, end: msgs.length };
    setWin(start, msgs.length);
    prevMsgsLenRef.current = msgs.length;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const shown = useMemo(() => msgs.slice(winStart, winEnd), [msgs, winStart, winEnd]);
  const olderCount = winStart;
  const newerCount = msgs.length - winEnd;
  // fresh reads for the paced load loop (closure values are stale by the
  // time the next frame runs)
  const winRef = useRef({ start: 0, end: 0 });
  winRef.current = { start: winStart, end: winEnd };
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const prevMsgsLenRef = useRef(0);
  // one batch per pause, BOTH directions share the gate — a trigger inside
  // the pause is dropped (not queued); the post-paint continuation keeps
  // feeding portions only while the sentinel stays within reach
  const lastLoadAt = useRef(0);
  // true while rows are loading at either end — drives the sentinel spinner
  const [olderBusy, setOlderBusy] = useState(false);
  const olderTimer = useRef(0);
  const [newerBusy, setNewerBusy] = useState(false);
  const newerTimer = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(olderTimer.current);
      clearTimeout(newerTimer.current);
    },
    [],
  );

  // scroll-content position of a row — measures exactly how far the view
  // moved when the window shifts (skeleton heights vary, so raw scrollHeight
  // deltas would mis-anchor by the evicted rows' height)
  const posOf = (id: string | undefined): number | null => {
    const root = listRef.current;
    if (!root || !id) return null;
    const el = root.querySelector(`[data-mid="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!el) return null;
    const rr = root.getBoundingClientRect();
    return el.getBoundingClientRect().top - rr.top + root.scrollTop;
  };

  // prepend one older batch, evicting from the BOTTOM when the window is at
  // cap (rows below the viewport unmount without shifting the reader). The
  // anchor row's measured shift is the exact prepend height — scrollTop is
  // compensated by it unless the reader sits at the very top on purpose.
  const loadOlder = useCallback(() => {
    const root = listRef.current;
    const win = winRef.current;
    if (!root || win.start <= 0) return;
    if (performance.now() - lastLoadAt.current < LOAD_PAUSE_MS) return;
    lastLoadAt.current = performance.now();
    setOlderBusy(true);
    clearTimeout(olderTimer.current);
    const start = Math.max(0, win.start - WIN_STEP);
    let end = win.end;
    if (end - start > MAX_WIN) end = start + MAX_WIN;
    // anchor = first rendered row that survives the move (stays mounted)
    let anchorId: string | undefined;
    for (let k = win.start; k < win.end; k++) {
      if (rowVisible(msgsRef.current[k])) {
        anchorId = msgsRef.current[k].info.id;
        break;
      }
    }
    const before = posOf(anchorId);
    const prevH = root.scrollHeight;
    const prevTop = root.scrollTop;
    const atTop = prevTop < 4;
    setWin(start, end);
    requestAnimationFrame(() => {
      if (!atTop) {
        const after = posOf(anchorId);
        if (before != null && after != null && after !== before) {
          root.scrollTop += after - before;
        } else if (before == null && after == null) {
          // anchor row not rendered (filtered) — fall back to net delta
          const dh = root.scrollHeight - prevH;
          if (dh > 0) root.scrollTop = prevTop + dh;
        }
        expected.current = root.scrollTop;
      }
      // paced continuation: one more portion later, only while in reach —
      // a far jump keeps counting down instead of trying to drain at once
      const t = topRef.current;
      const rr = root.getBoundingClientRect();
      if (t && winRef.current.start > 0 && t.getBoundingClientRect().bottom > rr.top - 1600) {
        olderTimer.current = window.setTimeout(() => loadOlderRef.current(), LOAD_PAUSE_MS);
      } else {
        olderTimer.current = window.setTimeout(() => setOlderBusy(false), 400);
      }
    });
  }, [setWin]);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // append one newer batch, evicting from the TOP when at cap — evicted rows
  // sit above the viewport, so scrollTop is compensated by their measured
  // height (the anchor row shifts up by exactly that much)
  const loadNewer = useCallback(() => {
    const root = listRef.current;
    const win = winRef.current;
    const len = msgsRef.current.length;
    if (!root || win.end >= len) return;
    if (performance.now() - lastLoadAt.current < LOAD_PAUSE_MS) return;
    lastLoadAt.current = performance.now();
    setNewerBusy(true);
    clearTimeout(newerTimer.current);
    let start = win.start;
    const end = Math.min(len, win.end + WIN_STEP);
    if (end - start > MAX_WIN) start = end - MAX_WIN;
    // anchor = first rendered row of the NEW window that is already mounted
    // (lies inside the old window) — its shift up is the evicted height
    let anchorId: string | undefined;
    for (let k = start; k < win.end; k++) {
      if (rowVisible(msgsRef.current[k])) {
        anchorId = msgsRef.current[k].info.id;
        break;
      }
    }
    const before = posOf(anchorId);
    const prevH = root.scrollHeight;
    setWin(start, end);
    requestAnimationFrame(() => {
      const after = posOf(anchorId);
      if (before != null && after != null && after !== before) {
        root.scrollTop -= before - after;
        expected.current = root.scrollTop;
      } else if (before == null && start > win.start) {
        // anchor not rendered — approximate by the net height change
        root.scrollTop -= prevH - root.scrollHeight;
        expected.current = root.scrollTop;
      }
      const t = newerRef.current;
      const rr = root.getBoundingClientRect();
      if (t && winRef.current.end < msgsRef.current.length && t.getBoundingClientRect().top < rr.bottom + 1600) {
        newerTimer.current = window.setTimeout(() => loadNewerRef.current(), LOAD_PAUSE_MS);
      } else {
        newerTimer.current = window.setTimeout(() => setNewerBusy(false), 400);
      }
    });
  }, [setWin]);
  const loadNewerRef = useRef(loadNewer);
  loadNewerRef.current = loadNewer;
  const topRef = useRef<HTMLDivElement>(null);
  const newerRef = useRef<HTMLDivElement>(null);
  // LazyMsgRow upgrade above the viewport would shove visible content down —
  // shift by the height delta so the reader's view stays put
  const shiftForGrowth = useCallback((dh: number, el: HTMLElement) => {
    const root = listRef.current;
    if (!root || dh === 0) return;
    if (el.getBoundingClientRect().top >= root.getBoundingClientRect().top) return;
    root.scrollTop += dh;
    expected.current = root.scrollTop;
  }, []);
  useEffect(() => {
    if (!olderCount) return;
    const root = listRef.current;
    const target = topRef.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) loadOlderRef.current();
      },
      // fire well before the reader hits the top — the next small batch
      // mounts in the background while they keep scrolling
      { root, rootMargin: "1600px 0px 0px 0px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [olderCount, sessionId]);
  useEffect(() => {
    if (!newerCount) return;
    const root = listRef.current;
    const target = newerRef.current;
    if (!root || !target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) loadNewerRef.current();
      },
      // fire before the reader reaches the bottom sentinel — the next batch
      // mounts in the background while they keep scrolling down
      { root, rootMargin: "0px 0px 0px 1600px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [newerCount, sessionId]);

  // jump straight to the tail, no animation
  const snap = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    expected.current = el.scrollHeight - el.clientHeight;
    el.scrollTop = el.scrollHeight;
  }, []);

  // park the window on the tail and land exactly on it — evicts everything
  // above (unload), then snap. Later growth (monaco/images upgrading after
  // paint) is re-pinned by the mutation/load observer below, not here.
  const gotoTail = useCallback(() => {
    const len = msgsRef.current.length;
    winRef.current = { start: Math.max(0, len - TAIL_FIRST), end: len };
    setWin(Math.max(0, len - TAIL_FIRST), len);
    snap();
  }, [setWin, snap]);

  // pill click: get back to the tail. Instant collapse + snap — an eased ride
  // would chase a tail that recedes while placeholder rows upgrade below the
  // viewport (each 44px skeleton grows to full height) and never land,
  // stranding the spinner. Collapse first, then snap onto the fresh tail.
  const goBottom = useCallback(() => {
    stick.current = true;
    setShowJump(false);
    gotoTail();
  }, [gotoTail]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // keep the window glued to the tail when it was there (streaming, fills):
    // follow list growth with the same size so rows slide out above the
    // viewport (unload up) instead of accumulating. A shrink (revert) that
    // leaves the window past the end parks it back on the tail.
    const prevLen = prevMsgsLenRef.current;
    if (msgs.length !== prevLen) {
      const parked = winRef.current.start >= msgs.length;
      const atTail = winRef.current.end >= prevLen;
      if (parked || atTail) {
        const size = parked ? TAIL_FIRST : Math.max(winRef.current.end - winRef.current.start, TAIL_FIRST);
        const start = Math.max(0, msgs.length - Math.min(size, MAX_WIN));
        if (parked || start !== winRef.current.start || msgs.length !== winRef.current.end) {
          if (stick.current) {
            // glued to the tail — land on the REAL newest message, don't
            // anchor: returning to a session whose fetch brought newer
            // messages must not strand the reader at the previous tail.
            // Post-commit + late growth is re-pinned by the observer below.
            setWin(start, msgs.length);
            snap();
          } else {
            // reading above the tail — keep the reader's anchor while the
            // window slides out rows above the viewport
            let anchorId: string | undefined;
            for (let k = start; k < winRef.current.end && k < msgs.length; k++) {
              if (rowVisible(msgs[k])) {
                anchorId = msgs[k].info.id;
                break;
              }
            }
            const before = posOf(anchorId);
            setWin(start, msgs.length);
            if (before != null) {
              requestAnimationFrame(() => {
                const after = posOf(anchorId);
                if (after != null && after !== before) {
                  el.scrollTop -= before - after;
                  expected.current = el.scrollTop;
                }
              });
            }
          }
        }
      }
    }
    prevMsgsLenRef.current = msgs.length;

    // replaced content (session switch / history fill): land at the bottom.
    // detected via the head message id so stream-end and trailing updates
    // on the SAME session never move the viewport.
    // boot restore fills skeletons first, content after — the loading flip
    // lands on the tail too, so the app spawns at the bottom.
    // outgoing message: always jump to the tail, wherever the reader was.
    const sig = `${sessionId}:${msgs[0]?.info.id ?? ""}`;
    const tail = msgs[msgs.length - 1];
    const sent = tail?.info.role === "user" && tail.info.id !== lastTail.current;
    lastTail.current = tail?.info.id;
    const justLoaded = wasLoading.current && !loading;
    wasLoading.current = !!loading;
    const settled = wasBusy.current && !busy && !compacting;
    wasBusy.current = !!busy || !!compacting;
    if (sig !== lastSig.current || sent || justLoaded) {
      lastSig.current = sig;
      stick.current = true;
      setShowJump(false);
      gotoTail();
      return;
    }
    // stream settled while pinned: land exactly onto the finished tail —
    // any later layout growth (monaco editors, images) re-pins via the
    // observer below
    if (settled && stick.current) {
      setShowJump(false);
      snap();
      return;
    }
  }, [msgs, busy, compacting, sessionId, loading, snap, gotoTail, setWin]);

  // event-driven tail pin: any content growth (streaming deltas, monaco
  // mounts/resizes, images, skeleton swaps, highlight) fires the observer or
  // a capture-phase load, which re-pins while the reader is glued — no
  // timers, no heuristics. Snaps coalesce to one per frame; genuine user
  // scrolls unpin via the scroll listener and cancel the queued snap.
  // We never mutate the DOM ourselves (scrollTop only), so this can't loop.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const refreshPill = () => {
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      // hysteresis so the pill can't flicker at one threshold
      setShowJump((v) => (v ? dist > 40 : dist > 80));
    };
    const queueSnap = () => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const root = listRef.current;
        if (!root || !stick.current) return;
        const target = root.scrollHeight - root.clientHeight;
        expected.current = target;
        if (root.scrollTop !== target) root.scrollTop = target;
        setShowJump(false);
      });
    };
    const onChange = () => {
      if (!stick.current) refreshPill();
      else queueSnap();
    };
    const mo = new MutationObserver(onChange);
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
    // img/video decode changes layout without a DOM mutation
    el.addEventListener("load", onChange, true);
    return () => {
      mo.disconnect();
      el.removeEventListener("load", onChange, true);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  // stick/unstick + pill visibility on scroll. Our snaps record their
  // scrollTop in `expected` first, so their scroll events are recognized
  // and ignored. Genuine reader scrolls (wheel/touch/pointer/scroll keys)
  // unpin instantly and kill any queued snap so it can't fight the reader.
  // Input-less scroll events are browser clamps: content shrinking ABOVE the
  // viewport (stream part swaps, tool-block collapse, window eviction)
  // re-anchors scrollTop and fires a scroll event that must NOT unpin —
  // otherwise a delta landing between the clamp and the event dispatch left
  // the tail permanently unglued. Those stay pinned and the queued snap
  // re-glues; two input-less scrolls in a row (scrollbar drag) are a real
  // reader move and unpin.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const INPUT_MS = 250;
    let lastInput = 0;
    let suspect = 0;
    const mark = () => {
      lastInput = performance.now();
    };
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchstart", mark, { passive: true });
    el.addEventListener("pointerdown", mark);
    const keyMark = (e: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) mark();
    };
    el.addEventListener("keydown", keyMark);
    const scroll = () => {
      if (Math.abs(el.scrollTop - expected.current) <= 2) {
        suspect = 0;
        return;
      }
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (dist <= 4) {
        // clamp re-landed us at the tail — stay glued
        stick.current = true;
        setShowJump(false);
        return;
      }
      if (performance.now() - lastInput < INPUT_MS) {
        suspect = 0;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        stick.current = false;
        setShowJump((v) => (v ? dist > 40 : dist > 80));
        return;
      }
      if (++suspect >= 2) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        stick.current = false;
        setShowJump((v) => (v ? dist > 40 : dist > 80));
      }
    };
    el.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf.current);
      el.removeEventListener("scroll", scroll);
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchstart", mark);
      el.removeEventListener("pointerdown", mark);
      el.removeEventListener("keydown", keyMark);
    };
  }, []);

  // chat history find — highlight all matches, active is opaque.
  // Gated on findOpen: while closed, msgs churn would still make the clear
  // pass scan the whole message DOM every streaming frame. Close cleans up
  // via oc:chat-find-clear instead.
  // The DOM walk is trailing-debounced 150ms (mirrors GitPanel's
  // scheduleRefresh): while find is open, every streaming delta re-fires
  // this effect and re-walks the entire rendered tree — coalesce to one
  // rebuild per 150ms pause instead. Clear + rebuild happen together in the
  // trailing pass; next/prev/cur/wrap semantics inside the walk are unchanged.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    if (!findOpen) return;
    const t = window.setTimeout(() => {
      // clear previous highlights
      root.querySelectorAll(".find-hit").forEach((el) => {
        const p = el.parentNode as HTMLElement | null;
        if (!p) return;
        const text = el.textContent ?? "";
        p.replaceChild(document.createTextNode(text), el);
        p.normalize();
      });
      if (!findOpen || !findQuery) {
        onFindHits?.(0);
        return;
      }
      const query = findQuery;
      const lowerQuery = findCase ? query : query.toLowerCase();
      const hits: HTMLElement[] = [];
      let globalIdx = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement as HTMLElement | null;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".find-hit, .copy-btn, .rewind, .fork, .jump-bottom, .chat-find, .img-lightbox, .reasoning-toggle")) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const textNodes: Text[] = [];
      let n: Text | null;
      while ((n = walker.nextNode() as Text | null)) textNodes.push(n);
      for (const textNode of textNodes) {
        const text = textNode.nodeValue ?? "";
        const hay = findCase ? text : text.toLowerCase();
        let pos = hay.indexOf(lowerQuery);
        if (pos === -1) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        let idx = pos;
        while (idx !== -1) {
          frag.appendChild(document.createTextNode(text.slice(last, idx)));
          const span = document.createElement("span");
          span.className = globalIdx === (findCur ?? 0) ? "find-hit active" : "find-hit";
          span.textContent = text.slice(idx, idx + query.length);
          frag.appendChild(span);
          hits.push(span);
          globalIdx++;
          last = idx + query.length;
          idx = hay.indexOf(lowerQuery, last);
        }
        frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode?.replaceChild(frag, textNode);
      }
      onFindHits?.(hits.length);
      if (hits.length) {
        const cur = ((findCur ?? 0) % hits.length + hits.length) % hits.length;
        const active = hits[cur];
        // find navigates the reader on purpose — never let a tail snap drag
        // them back while they inspect a hit
        stick.current = false;
        active?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 150);
    return () => window.clearTimeout(t);
  }, [findOpen, findQuery, findCase, findCur, msgs, onFindHits]);

  // clear chat find when requested (ChatPage close)
  useEffect(() => {
    const onClear = () => {
      const root = listRef.current;
      if (!root) return;
      root.querySelectorAll(".find-hit").forEach((el) => {
        const p = el.parentNode as HTMLElement | null;
        if (!p) return;
        p.replaceChild(document.createTextNode(el.textContent ?? ""), el);
        p.normalize();
      });
    };
    window.addEventListener("oc:chat-find-clear", onClear);
    return () => window.removeEventListener("oc:chat-find-clear", onClear);
  }, []);

  return (
    <PartCtx.Provider value={partCtx}>
      <div className="msgs-wrap">
      {findOpen && (
        <div className="chat-find" onMouseDown={(e) => e.preventDefault()}>
          <input
            ref={chatFindInputRef}
            className="chat-find-input mono"
            placeholder="Find in chat"
            value={findQuery ?? ""}
            autoFocus
            onChange={(e) => onFindQueryChange?.(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                onFindClose?.();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) onFindPrev?.();
                else onFindNext?.();
              }
            }}
          />
          <span className="chat-find-count mono">
            {findQuery ? `${findHits ? (findCur ?? 0) + 1 : 0}/${findHits ?? 0}` : ""}
          </span>
          <button className="icon-btn" data-tip="Previous (Shift+Enter)" onClick={onFindPrev}>
            <i className="fa-solid fa-chevron-up" />
          </button>
          <button className="icon-btn" data-tip="Next (Enter)" onClick={onFindNext}>
            <i className="fa-solid fa-chevron-down" />
          </button>
          <button className={"icon-btn fe-cs" + (findCase ? " on" : "")} data-tip="Match case" onClick={onFindCaseToggle}>
            Aa
          </button>
          <button className="icon-btn" data-tip="Close (Esc)" onClick={onFindClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
      )}
      <div className={`messages${busy ? " streaming" : ""}`} ref={listRef}>
        {loading && (
          <>
            <div className="msg skel user" />
            <div className="msg skel" style={{ width: "55%" }} />
            <div className="msg skel" style={{ width: "40%" }} />
          </>
        )}
        {!loading && msgs.length === 0 && !busy && <p className="empty">Say something…</p>}
        {!loading && olderCount > 0 && (
          <div ref={topRef} className="history-sentinel mono" onClick={() => loadOlderRef.current()}>
            <i className={`fa-solid ${olderBusy ? "fa-circle-notch fa-spin" : "fa-chevron-up"}`} />
            <span>
              {olderBusy
                ? `loading ${olderCount.toLocaleString()} older message${olderCount === 1 ? "" : "s"}…`
                : `${olderCount.toLocaleString()} older message${olderCount === 1 ? "" : "s"} — scroll up to load`}
            </span>
          </div>
        )}
        {shown.map((m, i) =>
          rowVisible(m) ? (
            <LazyMsgRow
              key={m.info.id}
              m={m}
              eager={winStart + i >= msgs.length - TAIL_FIRST}
              onShift={shiftForGrowth}
              onRevert={readOnly ? undefined : onRevert}
              onFork={readOnly ? undefined : onFork}
              onImage={setLightbox}
              readOnly={readOnly}
            />
          ) : null,
        )}
        {!loading && newerCount > 0 && (
          <div ref={newerRef} className="history-sentinel newer mono" onClick={() => loadNewerRef.current()}>
            <i className={`fa-solid ${newerBusy ? "fa-circle-notch fa-spin" : "fa-chevron-down"}`} />
            <span>
              {newerBusy
                ? `loading ${newerCount.toLocaleString()} newer message${newerCount === 1 ? "" : "s"}…`
                : `${newerCount.toLocaleString()} newer message${newerCount === 1 ? "" : "s"} — scroll down to load`}
            </span>
          </div>
        )}
        {compacting && (
          <div className="compacting">
            <i className="fa-solid fa-compress fa-spin" /> compacting context…
          </div>
        )}
        {busy && (
          <div className="thinking">
            <span className="cursor-dot" /> thinking
          </div>
        )}
      </div>
      <button
        type="button"
        className={`jump-bottom${showJump ? " show" : ""}`}
        data-tip="Back to tail"
        aria-label="Scroll to bottom"
        onClick={goBottom}
      >
        <i className="fa-solid fa-arrow-down" />
      </button>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      </div>
    </PartCtx.Provider>
  );
}
