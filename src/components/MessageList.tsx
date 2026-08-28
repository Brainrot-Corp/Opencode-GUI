import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import { iconFor } from "../lib/attachments";
import ToolBlock from "./ToolBlock";
import "../styles/chat.css";

// "User has answered your questions: "q"="a", ... . You can now continue ..."
// appears as a synthetic text part after the question tool is answered —
// render it with the same card+chip language as the ask (q-view/q-card)
// instead of a raw mono dump. Pairs are extracted via the quoted "q"="a" shape.
function parseAnsweredSummary(text: string): { q: string; a: string }[] | null {
  if (!text.trim().startsWith("User has answered your questions:")) return null;
  const pairs: { q: string; a: string }[] = [];
  const re = /"([^"]+)"\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) pairs.push({ q: m[1], a: m[2] });
  return pairs.length ? pairs : null;
}

function AnsweredSummary({ text }: { text: string }) {
  const pairs = parseAnsweredSummary(text);
  if (!pairs) return null;
  return (
    <div className="q-answered">
      <div className="q-answered-head mono">
        <i className="fa-solid fa-circle-check" />
        User answers
        <span className="q-answered-count">
          {pairs.length} {pairs.length === 1 ? "answer" : "answers"}
        </span>
      </div>
      <div className="q-view" style={{ padding: 0 }}>
        {pairs.map((p, i) => (
          <div key={i} className="q-card">
            <div className="q-text">{p.q}</div>
            <div className="q-opts">
              <span className="q-chip on">
                <i className="fa-solid fa-check" />
                {p.a}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="q-answered-foot mono">You can now continue with the user&apos;s answers in mind.</div>
    </div>
  );
}

// fenced code block with a fast copy button — textContent is read at click
// time so highlight spans / inline markup can never corrupt the copied source
function CodePre(props: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const { children, node, ...rest } = props;
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(ref.current?.textContent ?? "").then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="code-wrap">
      <button
        type="button"
        className="copy-btn"
        data-tip={copied ? "Copied" : "Copy"}
        aria-label="Copy code"
        onClick={copy}
      >
        <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
      </button>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

const mdComponents = { pre: CodePre };

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
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
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

function renderPart(
  part: Part,
  key: number,
  collapsedDefault?: boolean,
  onImage?: (url: string) => void,
) {
  if (part.type === "text") {
    const t = (part as any).text ?? "";
    if (!t.trim()) return null;
    if (parseAnsweredSummary(t)) return <AnsweredSummary key={key} text={t} />;
    return (
      <Markdown key={key} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
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
  if (part.type === "file") {
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
  });
}

// one conversation row — memoized so a streaming delta re-renders ONLY the
// message that grew; every other row skips its markdown/highlight pipeline
// (store swaps msg identity for touched messages, keeps others stable)
const MsgRow = memo(function MsgRow({
  m,
  collapsed,
  onRevert,
  onImage,
}: {
  m: Msg;
  collapsed?: boolean;
  onRevert?: (messageID: string) => void;
  onImage?: (url: string) => void;
}) {
  const err = m.info.role === "assistant" ? (m.info as any).error : null;
  const showErr = err && err.name !== "MessageAbortedError";
  const rawTs = (m.info as any).time?.completed ?? (m.info as any).time?.created;
  const short = fmtTime(rawTs);
  const full = fmtFull(rawTs);
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
      {m.parts.map((part, i) => renderPart(part, i, collapsed, onImage))}
      {short && (
        <div className="msg-time" data-tip={full} data-tip-cursor="">
          <i className="fa-solid fa-clock" />
          {short}
        </div>
      )}
    </div>
  );
});

export default function MessageList({
  msgs,
  busy,
  compacting,
  loading,
  collapsed,
  onRevert,
  sessionId,
}: {
  msgs: Msg[];
  busy: boolean;
  compacting?: boolean;
  loading?: boolean;
  // global /collapse default for thinking + tool blocks
  collapsed?: boolean;
  onRevert?: (messageID: string) => void;
  sessionId?: string;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [lightbox]);

  const listRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // last scrollTop we set ourselves — lets the scroll listener tell our own
  // programmatic scrolls (snap / eased chase) apart from the user's
  const expected = useRef(0);
  // "session:head-message" signature of the last render — a change means
  // content was replaced (switch/fill), not streamed onto
  const lastSig = useRef<string | undefined>(undefined);
  // pinned = reader is at the exact tail: follow every growth until they
  // scroll away (any distance). only real user input moves the pin —
  // content growth alone can never unpin, and an unpinned reader is never
  // moved by the app
  const stick = useRef(true);
  // tail message id at the previous render — detects an outgoing message
  const lastTail = useRef<string | undefined>(undefined);
  // bottom scrolled out of view → show the floating "back to tail" pill
  const [showJump, setShowJump] = useState(false);
  // true while the pill's smooth ride is in flight — suppresses pill
  // refreshes from content growth so it can't blink back mid-glide
  const riding = useRef(false);

  // jump straight to the tail, no animation
  const snap = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    cancelAnimationFrame(raf.current);
    expected.current = el.scrollHeight;
    el.scrollTop = el.scrollHeight;
  }, []);

  // eased chase toward the tail — text grows in place instead of snapping.
  // onDone lets callers react to the arrival (the jump pill hides itself
  // there: its own scrolls are invisible to the scroll listener)
  const follow = useCallback(
    (onDone?: () => void) => {
      cancelAnimationFrame(raf.current);
      const step = () => {
        const el = listRef.current;
        if (!el) return;
        const target = el.scrollHeight - el.clientHeight;
        const d = target - el.scrollTop;
        if (Math.abs(d) < 2) {
          expected.current = target;
          el.scrollTop = target;
          onDone?.();
          return;
        }
        expected.current = el.scrollTop + d * 0.22;
        el.scrollTop += d * 0.22;
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [],
  );

  // pill click: smooth ride back to the tail, then stay pinned for streaming
  const goBottom = useCallback(() => {
    stick.current = true;
    riding.current = true;
    setShowJump(false);
    follow(() => {
      riding.current = false;
    });
  }, [follow]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // replaced content (session switch / history fill): land at the bottom.
    // detected via the head message id so stream-end and trailing updates
    // on the SAME session never move the viewport.
    // outgoing message: always jump to the tail, wherever the reader was.
    const sig = `${sessionId}:${msgs[0]?.info.id ?? ""}`;
    const tail = msgs[msgs.length - 1];
    const sent = tail?.info.role === "user" && tail.info.id !== lastTail.current;
    lastTail.current = tail?.info.id;
    if (sig !== lastSig.current || sent) {
      lastSig.current = sig;
      stick.current = true;
      setShowJump(false);
      snap();
      return;
    }
    // refresh the pill while the reader is scrolled away and the bottom
    // drifts further out (streaming growth happens without scroll events) —
    // unless the jump ride is in flight, which owns the pill until it lands
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (!riding.current) setShowJump((v) => (v ? dist > 40 : dist > 80));
    // pinned readers chase the tail; unpinned readers are never touched
    if ((!busy && !compacting) || !stick.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) snap();
    else follow();
  }, [msgs, busy, compacting, sessionId, snap, follow]);

  // stick/unstick + pill visibility on scroll. Our eased chase and snaps
  // record their scrollTop in `expected` first, so their scroll events are
  // recognized and ignored — only genuine user scrolling moves the pin,
  // and it kills any chase in flight so it can never fight the reader.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const scroll = () => {
      if (Math.abs(el.scrollTop - expected.current) <= 2) return;
      // genuine user input — a running chase would otherwise drag the view
      // back down and mask the unpin; it also aborts any jump ride
      cancelAnimationFrame(raf.current);
      riding.current = false;
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      // zero-tolerance pin: ONLY the exact tail counts as "at the bottom"
      stick.current = dist <= 1;
      // hysteresis so the pill can't flicker at one threshold
      setShowJump((v) => (v ? dist > 40 : dist > 80));
    };
    el.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf.current);
      el.removeEventListener("scroll", scroll);
    };
  }, []);

  return (
    <div className="msgs-wrap">
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
          <MsgRow key={m.info.id} m={m} collapsed={collapsed} onRevert={onRevert} onImage={setLightbox} />
        ))}
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
      {lightbox &&
        createPortal(
          <div className="img-lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Image preview">
            <img src={lightbox} alt="" onClick={() => setLightbox(null)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
