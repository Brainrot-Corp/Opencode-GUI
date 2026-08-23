import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import "../styles/chat.css";

// one reasoning block — per-message visibility: the brain icon toggles THIS
// block only; /thinking flips the default for blocks not manually toggled
function Reasoning({ part, defaultOpen }: { part: Part; defaultOpen: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? defaultOpen;
  const t = (part as any).text ?? "";
  if (!t.trim()) return null;
  return (
    <div className={`reasoning${open ? " open" : ""}`}>
      <button
        type="button"
        className="reasoning-toggle"
        data-tip={open ? "Hide thinking for this message" : "Show thinking for this message"}
        onClick={() => setManual(!open)}
      >
        <i className="fa-solid fa-brain" />
        {!open && <span className="reasoning-label">thinking</span>}
      </button>
      {open && <div className="reasoning-body mono">{t}</div>}
    </div>
  );
}

function renderPart(part: Part, key: number, showThinking?: boolean) {
  if (part.type === "text") {
    const t = (part as any).text ?? "";
    if (!t.trim()) return null;
    return (
      <Markdown key={key} remarkPlugins={[remarkGfm]}>
        {t}
      </Markdown>
    );
  }
  if (part.type === "reasoning") {
    return <Reasoning key={(part as any).id || key} part={part} defaultOpen={!!showThinking} />;
  }
  if (part.type === "tool") {
    const tool = part as any;
    const status = tool.state?.status ?? "";
    const cls = status === "error" ? "error" : status === "completed" ? "done" : "";
    return (
      <div key={key} className={`tool-line ${cls}`}>
        <i className={`fa-solid ${status === "error" ? "fa-triangle-exclamation" : "fa-gear"}${status === "running" || status === "pending" ? " fa-spin-pulse" : ""}`} />
        {tool.tool}
        <span className="tool-status">[{status}]</span>
      </div>
    );
  }
  return null;
}

export default function MessageList({
  msgs,
  busy,
  loading,
  showThinking,
  onRevert,
  sessionId,
}: {
  msgs: Msg[];
  busy: boolean;
  loading?: boolean;
  showThinking?: boolean;
  onRevert?: (messageID: string) => void;
  sessionId?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // "session:head-message" signature of the last render — a change means
  // content was replaced (switch/fill), not streamed onto
  const lastSig = useRef<string | undefined>(undefined);
  // while streaming, follow the tail — until the user scrolls away from it
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const snap = () => {
      cancelAnimationFrame(raf.current);
      el.scrollTop = el.scrollHeight;
    };
    // eased chase toward the tail — text grows in place instead of snapping
    const follow = () => {
      cancelAnimationFrame(raf.current);
      const step = () => {
        const el = listRef.current;
        if (!el) return;
        const target = el.scrollHeight - el.clientHeight;
        const d = target - el.scrollTop;
        if (Math.abs(d) < 2) {
          el.scrollTop = target;
          return;
        }
        el.scrollTop += d * 0.22;
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    };

    // replaced content (session switch / history fill): land at the bottom.
    // detected via the head message id so stream-end and trailing updates
    // on the SAME session never move the viewport
    const sig = `${sessionId}:${msgs[0]?.info.id ?? ""}`;
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      stick.current = true;
      snap();
      return;
    }
    // stream end / idle: leave the reader exactly where they are
    if (!busy || !stick.current) return;
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    // tail ran far ahead (bulk output, or height grew above the viewport —
    // e.g. an expanded thinking block): stop chasing, the reader decides
    // when to come back. only a near-tail scroll re-attaches.
    if (dist > el.clientHeight * 1.5) {
      stick.current = false;
      cancelAnimationFrame(raf.current);
      return;
    }
    // small growth: ease after it (no animation under reduced motion)
    if (reduced) snap();
    else follow();
  }, [msgs, busy, sessionId]);

  // stick/unstick: ANY scroll that increases the gap to the tail detaches
  // the follower (wheel-up, scrollbar drag, PageUp…), returning near the
  // tail re-attaches
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let lastDist = 0;
    const scroll = () => {
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (dist < 48) stick.current = true;
      else if (dist > lastDist + 2) stick.current = false;
      lastDist = dist;
    };
    el.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf.current);
      el.removeEventListener("scroll", scroll);
    };
  }, []);

  return (
    <div className={`messages${busy ? " streaming" : ""}`} ref={listRef}>
      {loading && (
        <>
          <div className="msg skel user" />
          <div className="msg skel" style={{ width: "55%" }} />
          <div className="msg skel" style={{ width: "40%" }} />
        </>
      )}
      {!loading && msgs.length === 0 && !busy && <p className="empty">Say something…</p>}
      {msgs.map((m) =>
        m.parts.some((p) => renderPart(p, 0, showThinking)) || m.info.role === "user" ? (
          <div key={m.info.id} className={`msg ${m.info.role}`}>
            {m.info.role === "user" && onRevert && (
              <button
                className="rewind"
                data-tip="Rewind conversation to here"
                onClick={() => onRevert(m.info.id)}
              >
                <i className="fa-solid fa-clock-rotate-left" />
              </button>
            )}
            {m.parts.map((part, i) => renderPart(part, i, showThinking))}
          </div>
        ) : null,
      )}
      {busy && (
        <div className="thinking">
          <span className="cursor-dot" /> thinking
        </div>
      )}
    </div>
  );
}
