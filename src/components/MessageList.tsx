import { Children, isValidElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";
import { iconFor } from "../lib/attachments";
import ToolBlock from "./ToolBlock";
import MonacoBlock from "./MonacoBlock";
import { hlToMonacoLang, loadMonaco } from "../lib/monaco";
import { stripAnsi } from "../lib/syntax";
import "../styles/chat.css";
import "../styles/find.css";

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

// <task id="..." state="completed"><task_result>...markdown...</task_result></task>
// appears as a fenced perl block in text parts. Render it like other tool
// calls — tool-block chrome with markdown body instead of raw XML/dump.
const TASK_RE = /(?:```\w*\s*)?<task\b[^>]*>[\s\S]*?<\/task>(?:\s*```)?/gi;

function extractTaskEntries(text: string): { id?: string; state?: string; result: string; raw: string }[] | null {
  const out: { id?: string; state?: string; result: string; raw: string }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(TASK_RE.source, "gi");
  while ((m = re.exec(text))) {
    const raw = m[0];
    const id = raw.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1] ?? raw.match(/\bid\s*=\s*([^\s>]+)/)?.[1];
    const state = raw.match(/\bstate\s*=\s*["']([^"']+)["']/)?.[1] ?? raw.match(/\bstate\s*=\s*([^\s>]+)/)?.[1];
    const inner = raw.match(/<task_result>([\s\S]*?)<\/task_result>/i)?.[1]
      ?? raw.replace(/<task\b[^>]*>/i, "").replace(/<\/task>/i, "").replace(/```\w*\s*/g, "").replace(/```/g, "").trim();
    out.push({ id, state, result: inner.trim(), raw });
  }
  return out.length ? out : null;
}

function TaskResultBlock({
  id,
  state,
  result,
  collapsedDefault,
  taskCosts,
  onOpenSubagent,
}: {
  id?: string;
  state?: string;
  result: string;
  collapsedDefault?: boolean;
  taskCosts?: Record<string, { cost: number; tokens: number }>;
  onOpenSubagent?: (id: string | null, part?: any) => void;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const isErr = state === "failed" || state === "error";
  const open = manual ?? (isErr || !collapsedDefault);
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    if (!result.trim()) return;
    navigator.clipboard.writeText(result).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  const shortId = id ? (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id) : "";
  return (
    <div className={`tool-block task-result ${state ?? ""}${open ? " open" : ""}${isErr ? " error" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="tool-head mono"
        onClick={() => setManual(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setManual(!open);
          }
        }}
      >
        <i
          className={`fa-solid ${isErr ? "fa-triangle-exclamation" : state === "completed" ? "fa-circle-check" : "fa-diagram-project"} tool-ico`}
        />
        <span className="tool-name">task</span>
        {shortId &&
          (id && onOpenSubagent ? (
            <button
              type="button"
              className="tool-title link"
              data-tip={`Open subagent transcript ${id}`}
              aria-label="Open subagent transcript"
              onClick={(e) => {
                e.stopPropagation();
                onOpenSubagent(id);
              }}
            >
              {shortId}
              <i className="fa-solid fa-arrow-up-right-from-square" style={{ marginLeft: 6 }} />
            </button>
          ) : (
            <span className="tool-title" data-tip={id}>
              {shortId}
            </span>
          ))}
        {state && (
          <span className="tool-stat mono">
            <em className={isErr ? "del" : ""}>{state}</em>
          </span>
        )}
        {(() => {
          const tc = id ? taskCosts?.[id] : null;
          if (!tc || (!tc.cost && !tc.tokens)) return null;
          const tok = tc.tokens ? fmtTok(tc.tokens) : "";
          return (
            <span className="tool-cost mono" data-tip={`${tc.tokens.toLocaleString()} tokens${tc.cost ? ` · $${tc.cost.toFixed(4)}` : ""}`}>
              {tok && `${tok} tok`}
              {tok && tc.cost ? " · " : ""}
              {tc.cost ? `$${tc.cost.toFixed(4)}` : ""}
            </span>
          );
        })()}
        <span style={{ flex: 1 }} />
        {result.trim() && (
          <button
            type="button"
            className="tool-eye"
            data-tip={copied ? "Copied" : "Copy result"}
            aria-label="Copy task result"
            onClick={(e) => {
              e.stopPropagation();
              doCopy();
            }}
          >
            <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
          </button>
        )}
        <button
          type="button"
          className="tool-eye"
          data-tip={open ? "Collapse" : "Expand"}
          aria-label={open ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            setManual(!open);
          }}
        >
          <i className={`fa-solid ${open ? "fa-eye" : "fa-eye-slash"}`} />
        </button>
      </div>
      {open && (
        <div className="tool-body mono">
          {result.trim() ? (
            <div className="task-report">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
                {result}
              </Markdown>
            </div>
          ) : (
            <span className="part-note mono" style={{ opacity: 0.6 }}>
              no result
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TaskMixed({ text, collapsedDefault, taskCosts, onOpenSubagent }: { text: string; collapsedDefault: boolean; taskCosts?: Record<string, { cost: number; tokens: number }>; onOpenSubagent?: (id: string | null, part?: any) => void }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = 0;
  const re = new RegExp(TASK_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index);
    if (before.trim()) {
      parts.push(
        <Markdown
          key={`pre-${idx++}`}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={mdComponents}
        >
          {before}
        </Markdown>,
      );
    }
    const raw = m[0];
    const id = raw.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1] ?? raw.match(/\bid\s*=\s*([^\s>]+)/)?.[1];
    const state = raw.match(/\bstate\s*=\s*["']([^"']+)["']/)?.[1] ?? raw.match(/\bstate\s*=\s*([^\s>]+)/)?.[1];
    const result =
      raw.match(/<task_result>([\s\S]*?)<\/task_result>/i)?.[1]?.trim() ??
      raw.replace(/<task\b[^>]*>/i, "").replace(/<\/task>/i, "").replace(/```\w*\s*/g, "").replace(/```/g, "").trim();
    parts.push(
      <TaskResultBlock
        key={`task-${idx++}`}
        id={id}
        state={state}
        result={result}
        collapsedDefault={collapsedDefault}
        taskCosts={taskCosts}
        onOpenSubagent={onOpenSubagent}
      />,
    );
    last = re.lastIndex;
  }
  const after = text.slice(last);
  if (after.trim()) {
    parts.push(
      <Markdown
        key={`post-${idx++}`}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={mdComponents}
      >
        {after}
      </Markdown>,
    );
  }
  return <>{parts}</>;
}

function SubtaskBlock({ part, collapsedDefault, onOpenSubagent }: { part: any; collapsedDefault: boolean; onOpenSubagent?: (id: string | null, part?: any) => void }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const prompt: string = typeof part.prompt === "string" ? part.prompt : "";
  const desc: string = typeof part.description === "string" ? part.description : "";
  const name: string = part.name ?? part.agent ?? "agent";
  const isSub = part.type === "subtask";
  const hasBody = !!prompt.trim();
  const open = manual ?? (!collapsedDefault && hasBody);
  return (
    <div className={`tool-block subtask${open ? " open" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="tool-head mono"
        onClick={() => hasBody && setManual(!open)}
        onKeyDown={(e) => {
          if (!hasBody) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setManual(!open);
          }
        }}
        style={!hasBody ? { cursor: "default" } : undefined}
      >
        <i className="fa-solid fa-diagram-project tool-ico" />
        <span className="tool-name">{isSub ? "subtask" : "agent"}</span>
        <span className="tool-title">{name}</span>
        {desc && (
          <span className="tool-title" style={{ opacity: 0.65 }}>
            — {desc}
          </span>
        )}
        {onOpenSubagent && (
          <button
            type="button"
            className="tool-eye"
            data-tip="Open subagent transcript"
            aria-label="Open subagent transcript"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSubagent(null, part);
            }}
          >
            <i className="fa-solid fa-arrow-up-right-from-square" />
          </button>
        )}
        {hasBody && (
          <button
            type="button"
            className="tool-eye"
            data-tip={open ? "Collapse" : "Expand"}
            aria-label={open ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              setManual(!open);
            }}
          >
            <i className={`fa-solid ${open ? "fa-eye" : "fa-eye-slash"}`} />
          </button>
        )}
      </div>
      {open && hasBody && (
        <div className="tool-body mono">
          <div className="task-report" style={{ whiteSpace: "pre-wrap" }}>
            {prompt}
          </div>
        </div>
      )}
    </div>
  );
}

// markdown helpers shared by the pre renderer below
function codeText(node: ReactNode): string {
  let out = "";
  Children.forEach(node, (c) => {
    if (typeof c === "string" || typeof c === "number") out += String(c);
    else if (isValidElement(c)) out += codeText((c.props as any).children);
  });
  return out;
}
// rehype-highlight tags the <code> with language-<id> (highlight.js ids)
function codeLang(node: ReactNode): string | undefined {
  const kids = Children.toArray(node);
  for (const c of kids) {
    if (!isValidElement(c)) continue;
    if (c.type === "code") {
      const m = /language-([\w-]+)/.exec((c.props as any).className ?? "");
      if (m) return m[1];
    }
    const nested = codeLang((c.props as any).children);
    if (nested) return nested;
  }
  return undefined;
}

// fenced code block with a fast copy button — Monaco rendering under the
// same .code-wrap chrome; copy uses the raw source so rendered markup (or
// monaco's gutter) can never corrupt it. Untagged fences stay plaintext,
// exactly like the old rehype-only rendering. Monaco editors are heavy (one
// per fence), so the editor only mounts once the block nears the viewport —
// huge histories mount <pre> placeholders until scrolled to.
function CodePre(props: { children?: ReactNode }) {
  const { children } = props;
  // strip terminal escapes: <pre> swallowed them invisibly, Monaco would
  // draw them as glyphs; copy matches what's seen
  const text = stripAnsi(codeText(children));
  const lang = hlToMonacoLang(codeLang(children));
  const [copied, setCopied] = useState(false);
  const [near, setNear] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (near) return;
    const el = boxRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      // upgrade ahead of the viewport so the editor is ready on arrival
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="code-wrap" ref={boxRef}>
      <button
        type="button"
        className="copy-btn"
        data-tip={copied ? "Copied" : "Copy"}
        aria-label="Copy code"
        onClick={copy}
      >
        <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
      </button>
      {near ? (
        <MonacoBlock
          value={text}
          language={lang}
          fontSize={12.5}
          lineHeight={21}
          padTop={12}
          padBottom={12}
          leftPad={14}
          className="code-mono"
          fallback={<pre>{text}</pre>}
        />
      ) : (
        <pre>{text}</pre>
      )}
    </div>
  );
}

const mdComponents = { pre: CodePre };

// one reasoning block — per-message visibility: the brain icon toggles THIS
// block only; /collapse flips the default for blocks not manually toggled
function Reasoning({ part, defaultOpen, streaming }: { part: Part; defaultOpen: boolean; streaming?: boolean }) {
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
          {streaming && t.length > STREAM_RAW_LIMIT ? (
            <pre className="stream-raw">{t}</pre>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
              {t}
            </Markdown>
          )}
        </div>
      )}
    </div>
  );
}

// past this length a still-streaming part renders as plain text instead of
// re-running markdown+highlight every delta (final render on completion)
const STREAM_RAW_LIMIT = 12000;

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
  taskCosts?: Record<string, { cost: number; tokens: number }>,
  partDir?: string,
  streaming?: boolean,
  onOpenSubagent?: (id: string | null, part?: any) => void,
) {
  if (part.type === "text") {
    const t = (part as any).text ?? "";
    if (!t.trim()) return null;
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
      return <TaskMixed key={key} text={t} collapsedDefault={!!collapsedDefault} taskCosts={taskCosts} onOpenSubagent={onOpenSubagent} />;
    }
    return (
      <Markdown key={key} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
        {t}
      </Markdown>
    );
  }
  if (part.type === "reasoning") {
    return <Reasoning key={(part as any).id || key} part={part} defaultOpen={!collapsedDefault} streaming={streaming} />;
  }
  if (part.type === "tool") {
    return <ToolBlock key={(part as any).id || key} part={part} collapsedDefault={!!collapsedDefault} taskCosts={taskCosts} dir={partDir} onOpenSubagent={onOpenSubagent} />;
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
    return <SubtaskBlock key={(part as any).id || key} part={part as any} collapsedDefault={!!collapsedDefault} onOpenSubagent={onOpenSubagent} />;
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
  collapsed,
  onRevert,
  onFork,
  onImage,
  taskCosts,
  dir,
  readOnly,
  onOpenSubagent,
}: {
  m: Msg;
  eager: boolean;
  onShift: (dh: number, el: HTMLDivElement) => void;
  collapsed?: boolean;
  onRevert?: (messageID: string) => void;
  onFork?: (messageID: string) => void;
  onImage?: (url: string) => void;
  taskCosts?: Record<string, { cost: number; tokens: number }>;
  dir?: string;
  readOnly?: boolean;
  onOpenSubagent?: (id: string | null, part?: any) => void;
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
          {m.parts.map((part, i) => renderPart(part, i, collapsed, onImage, taskCosts, dir, streaming, onOpenSubagent))}
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
  useEffect(() => {
    if (!lightbox) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [lightbox]);

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
  // programmatic scrolls (snap / eased chase) apart from the user's
  const expected = useRef(0);
  // "session:head-message" signature of the last render — a change means
  // content was replaced (switch/fill), not streamed onto
  const lastSig = useRef<string | undefined>(undefined);
  // boot fill arrives as skeletons-then-content — landing needs the
  // loading→ready flip too, not just the head-message signature
  const wasLoading = useRef(false);
  // stream end while pinned — late layout (monaco editors, images) grows
  // content after the last chase frame, so land exactly instead of hovering
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

  // pinned while streaming: glue to the tail every frame. The old eased chase
  // (22% of the distance per frame) fell behind when a burst landed at once —
  // and rAF starves under markdown/highlight/monaco work — stranding the
  // reader above the bottom. An instant snap per frame catches growth from any
  // source (deltas, monaco upgrades, images) until unpinned or settled.
  // Guarded restart: rapid deltas must not cancel the running loop.
  const follow = useCallback(() => {
    if (raf.current) return;
    const step = () => {
      const el = listRef.current;
      if (!el || !stick.current) {
        raf.current = 0;
        return;
      }
      const target = el.scrollHeight - el.clientHeight;
      expected.current = target;
      if (el.scrollTop !== target) el.scrollTop = target;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, []);

  // park the window on the tail and land exactly on it — evicts everything
  // above (unload), then snap + re-snap next frame for late layout growth
  const gotoTail = useCallback(() => {
    const len = msgsRef.current.length;
    winRef.current = { start: Math.max(0, len - TAIL_FIRST), end: len };
    setWin(Math.max(0, len - TAIL_FIRST), len);
    snap();
    requestAnimationFrame(() => snap());
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
            // messages must not strand the reader at the previous tail
            setWin(start, msgs.length);
            snap();
            requestAnimationFrame(() => snap());
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
    // stream settled while pinned: the loop stopped on the busy flip, so late
    // layout (monaco editors, images) may have grown rows after its last
    // frame — land exactly onto the finished tail
    if (settled && stick.current) {
      setShowJump(false);
      snap();
      requestAnimationFrame(() => snap());
      return;
    }
    // refresh the pill while the reader is scrolled away and the bottom
    // drifts further out (streaming growth happens without scroll events)
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    setShowJump((v) => (v ? dist > 40 : dist > 80));
    // pinned readers stay glued to the tail; unpinned readers are never touched
    if ((!busy && !compacting) || !stick.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) snap();
    else follow();
  }, [msgs, busy, compacting, sessionId, loading, snap, follow, gotoTail, setWin]);

  // stick/unstick + pill visibility on scroll. Our pin loop and snaps
  // record their scrollTop in `expected` first, so their scroll events are
  // recognized and ignored — only genuine user scrolling moves the pin,
  // and it kills any loop in flight so it can never fight the reader.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const scroll = () => {
      if (Math.abs(el.scrollTop - expected.current) <= 2) return;
      // genuine user input — a running loop would otherwise drag the view
      // back down and mask the unpin
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
      // epsilon pin: fractional DPR/zoom can leave dist at 0.4-1.2px
      stick.current = dist <= 4;
      // hysteresis so the pill can't flicker at one threshold
      setShowJump((v) => (v ? dist > 40 : dist > 80));
    };
    el.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf.current);
      el.removeEventListener("scroll", scroll);
    };
  }, []);

  // chat history find — highlight all matches, active is opaque.
  // Gated on findOpen: while closed, msgs churn would still make the clear
  // pass scan the whole message DOM every streaming frame. Close cleans up
  // via oc:chat-find-clear instead.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    if (!findOpen) return;
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
      active?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
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
              collapsed={collapsed}
              onRevert={readOnly ? undefined : onRevert}
              onFork={readOnly ? undefined : onFork}
              onImage={setLightbox}
              taskCosts={taskCosts}
              dir={dir}
              readOnly={readOnly}
              onOpenSubagent={onOpenSubagent}
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
