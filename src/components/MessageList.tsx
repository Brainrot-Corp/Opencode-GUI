import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import { iconFor } from "../lib/attachments";
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

const TOOL_ICONS: Record<string, string> = {
  read: "fa-file-lines",
  write: "fa-pen",
  edit: "fa-pen",
  multiedit: "fa-pen",
  patch: "fa-pen",
  bash: "fa-terminal",
  glob: "fa-magnifying-glass",
  grep: "fa-table-list",
  list: "fa-list",
  webfetch: "fa-globe",
  task: "fa-diagram-project",
  todowrite: "fa-list-check",
  todo: "fa-list-check",
};

function fmtTok(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

// one tool call — streams through pending → running → completed|error as
// part.updated replaces this part; collapsed by default, auto-expanded for
// errors and very short outputs
function ToolBlock({ part }: { part: Part }) {
  const t = part as any;
  const st = t.state ?? {};
  const status: string = st.status ?? "";
  const [manual, setManual] = useState<boolean | null>(null);

  const out = status === "completed" ? st.output ?? "" : status === "error" ? st.error ?? "" : "";
  const outLines = out ? out.split("\n").length : 0;
  const open = manual ?? (status === "error" || (outLines > 0 && outLines <= 3));

  const input: [string, unknown][] = Object.entries(st.input ?? {});
  const title =
    st.title ||
    (() => {
      const fv = input.find(([, v]) => v != null && v !== "");
      const s = fv ? (typeof fv[1] === "string" ? fv[1] : JSON.stringify(fv[1])) : "";
      return s.length > 90 ? `${s.slice(0, 90)}…` : s;
    })() ||
    t.tool;

  const ms = st.time?.start && st.time?.end ? st.time.end - st.time.start : null;
  const dur = ms == null ? null : ms < 10000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms / 1000)}s`;

  return (
    <div className={`tool-block ${status}${open ? " open" : ""}`}>
      <button type="button" className="tool-head mono" onClick={() => setManual(!open)}>
        <i className={`fa-solid ${TOOL_ICONS[(t.tool as string)?.toLowerCase()] ?? "fa-gear"} tool-ico`} />
        <span className="tool-name">{t.tool}</span>
        <span className="tool-title">{title}</span>
        {dur && <span className="tool-dur">{dur}s</span>}
        {status === "running" || status === "pending" ? (
          <i className="fa-solid fa-circle-notch fa-spin-pulse tool-state" />
        ) : status === "error" ? (
          <i className="fa-solid fa-triangle-exclamation tool-state" />
        ) : (
          <i className="fa-solid fa-chevron-right chev" />
        )}
      </button>
      {open && (
        <div className="tool-body mono">
          {input.length > 0 && (
            <pre className="tool-input">
              {input.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}
            </pre>
          )}
          {out && <pre className="tool-out">{out}</pre>}
        </div>
      )}
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
    return <ToolBlock key={(part as any).id || key} part={part} />;
  }
  if (part.type === "step-finish") {
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
  if (part.type === "file") {
    const f = part as any;
    const url: string = f.url ?? "";
    const mime: string = f.mime ?? "";
    const name = f.filename || "file";
    if (mime.startsWith("image/") && url)
      return <img key={key} className="file-img" src={url} alt={name} loading="lazy" />;
    if (mime.startsWith("video/") && url)
      return <video key={key} className="file-video" src={url} controls preload="metadata" />;
    return (
      <div key={key} className="file-chip mono">
        <i className={`fa-solid ${iconFor(mime)}`} />
        {name}
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
