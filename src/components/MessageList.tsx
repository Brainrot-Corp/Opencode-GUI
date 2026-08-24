import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import ToolBlock from "./ToolBlock";
import "../styles/chat.css";

// one reasoning block — per-message visibility: the brain icon toggles THIS
// block only; /collapse flips the default for blocks not manually toggled
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
      {/* same markdown+highlight pipeline as replies so fenced code in the
          thinking stream gets colored instead of flat grey */}
      {open && (
        <div className="reasoning-body">
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {t}
          </Markdown>
        </div>
      )}
    </div>
  );
}

function fmtTok(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

function renderPart(part: Part, key: number, collapsedDefault?: boolean) {
  if (part.type === "text") {
    const t = (part as any).text ?? "";
    if (!t.trim()) return null;
    return (
      <Markdown key={key} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {t}
      </Markdown>
    );
  }
  if (part.type === "reasoning") {
    return <Reasoning key={(part as any).id || key} part={part} defaultOpen={!collapsedDefault} />;
  }
  if (part.type === "tool") {
    return <ToolBlock key={(part as any).id || key} part={part} collapsedDefault={!!collapsedDefault} />;
  }
  if (part.type === "step-finish") {
    const sf = part as any;
    const tk = sf.tokens ?? {};
    const total = (tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0);
    // an empty step (no tokens, no cost) is noise — hide it
    if (!total && !sf.cost) return null;
    return (
      <div key={key} className="part-note mono">
        <i className="fa-solid fa-shoe-prints" />
        step · {fmtTok(total)} tok
        {sf.cost > 0 && ` · $${sf.cost.toFixed(4)}`}
      </div>
    );
  }
  if (part.type === "retry") {
    const r = part as any;
    return (
      <div key={key} className="part-note retry mono">
        <i className="fa-solid fa-rotate-right" />
        retrying (attempt {r.attempt})
        {r.error?.message ? ` — ${r.error.message}` : ""}
      </div>
    );
  }
  if (part.type === "compaction") {
    const c = part as any;
    return (
      <div key={key} className="part-note mono">
        <i className="fa-solid fa-compress" />
        context compacted{c.auto ? "" : " (manual)"}
      </div>
    );
  }
  if (part.type === "patch") {
    const pt = part as any;
    const files: string[] = pt.files ?? [];
    if (!files.length) return null;
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
  if (part.type === "agent" || part.type === "subtask") {
    const a = part as any;
    return (
      <div key={key} className="part-note mono">
        <i className="fa-solid fa-robot" />
        {a.name || a.agent}
        {a.description ? ` — ${a.description}` : ""}
      </div>
    );
  }
  return null;
}

// human-readable text from a NamedError-shaped message error
function errText(err: any): string {
  return err?.data?.message || err?.message || err?.name || "unknown error";
}

// cheap row-visibility check mirroring renderPart's null branches — without
// building throwaway elements (the old .some(renderPart(…)) rendered every
// message on every pass just to decide what to skip)
function rowVisible(m: Msg): boolean {
  if (m.info.role === "user") return true;
  const err = m.info.role === "assistant" ? (m.info as any).error : null;
  if (err && err.name !== "MessageAbortedError") return true;
  return m.parts.some((p: any) => {
    switch (p.type) {
      case "text":
        return !!(p.text ?? "").trim();
      case "step-finish": {
        const tk = p.tokens ?? {};
        return !!((tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0)) || !!p.cost;
      }
      case "patch":
        return !!(p.files ?? []).length;
      default:
        return ["reasoning", "tool", "retry", "compaction", "agent", "subtask"].includes(p.type);
    }
  });
}

// one conversation row — memoized so a streaming delta re-renders ONLY the
// message that grew; every other row skips its markdown/highlight pipeline
// (store swaps msg identity for touched messages, keeps others stable)
const MsgRow = memo(function MsgRow({
  m,
  collapsed,
  onRevert,
}: {
  m: Msg;
  collapsed?: boolean;
  onRevert?: (messageID: string) => void;
}) {
  const err = m.info.role === "assistant" ? (m.info as any).error : null;
  const showErr = err && err.name !== "MessageAbortedError";
  return (
    <div className={`msg ${m.info.role}${showErr ? " msg-error" : ""}`}>
      {m.info.role === "user" && onRevert && (
        <button
          className="rewind"
          data-tip="Rewind conversation to here"
          onClick={() => onRevert(m.info.id)}
        >
          <i className="fa-solid fa-clock-rotate-left" />
        </button>
      )}
      {showErr && (
        <div className="msg-err-line">
          <i className="fa-solid fa-triangle-exclamation" />
          <span>{errText(err)}</span>
        </div>
      )}
      {m.parts.map((part, i) => renderPart(part, i, collapsed))}
    </div>
  );
});

export default function MessageList({
  msgs,
  busy,
  loading,
  collapsed,
  onRevert,
  sessionId,
}: {
  msgs: Msg[];
  busy: boolean;
  loading?: boolean;
  // global /collapse default for thinking + tool blocks
  collapsed?: boolean;
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
      {msgs.filter(rowVisible).map((m) => (
        <MsgRow key={m.info.id} m={m} collapsed={collapsed} onRevert={onRevert} />
      ))}
      {busy && (
        <div className="thinking">
          <span className="cursor-dot" /> thinking
        </div>
      )}
    </div>
  );
}
