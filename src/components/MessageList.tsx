import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";

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
        ⚙ {tool.tool} [{status}]
      </div>
    );
  }
  return null;
}

export default function MessageList({ msgs, busy }: { msgs: Msg[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView();
  }, [msgs]);

  return (
    <div className="messages">
      {msgs.length === 0 && !busy && <p className="empty">Say something…</p>}
      {msgs.map((m) =>
        m.parts.some((p) => renderPart(p, 0)) ? (
          <div key={m.info.id} className={`msg ${m.info.role}`}>
            {m.parts.map((part, i) => renderPart(part, i))}
          </div>
        ) : m.info.role === "user" ? (
          <div key={m.info.id} className={`msg ${m.info.role}`} />
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
