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
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // manual scrollTop — never scrollIntoView(), it also scrolls page-level
    // ancestors and shoves the whole layout off-screen
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    void endRef.current;
  }, [msgs]);

  return (
    <div className="messages" ref={listRef}>
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
      <div ref={endRef} />
    </div>
  );
}
