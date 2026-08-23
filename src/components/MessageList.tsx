import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import "../styles/chat.css";

function renderPart(part: Part, key: number) {
  if (part.type === "text") {
    const t = (part as any).text ?? "";
    if (!t.trim()) return null;
    return (
      <Markdown key={key} remarkPlugins={[remarkGfm]}>
        {t}
      </Markdown>
    );
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
  onRevert,
}: {
  msgs: Msg[];
  busy: boolean;
  loading?: boolean;
  onRevert?: (messageID: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // while streaming, follow the tail — until the user scrolls up
  const stick = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const snap = () => {
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

    if (!busy) {
      // history load / session switch / stream finished: land at the bottom
      stick.current = true;
      snap();
      return;
    }
    if (!stick.current) return;
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    // huge jump = fresh session content: snap; small growth: ease after it
    if (dist > el.clientHeight * 3 || reduced) snap();
    else follow();
  }, [msgs, busy]);

  // stick/unstick: scrolling up detaches the follower, returning to the
  // tail re-attaches
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stick.current = false;
    };
    const scroll = () => {
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (dist < 48) stick.current = true;
    };
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf.current);
      el.removeEventListener("wheel", wheel);
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
        m.parts.some((p) => renderPart(p, 0)) || m.info.role === "user" ? (
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
            {m.parts.map((part, i) => renderPart(part, i))}
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
