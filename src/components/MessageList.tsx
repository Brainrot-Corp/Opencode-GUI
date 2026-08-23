import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Part } from "@opencode-ai/sdk/client";
import type { Msg, QuestionInfo } from "../types";
import { iconFor } from "../lib/attachments";
import { hlHtml, extLang } from "../lib/syntax";
import { DiffLines } from "./DiffPanel";
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

// highlighted mono text for tool inputs/outputs — language auto-detected,
// oversized/odd input falls back to escaped plain text inside hlHtml
function Hi({ text }: { text: string }) {
  const html = useMemo(() => ({ __html: hlHtml(text) }), [text]);
  return <span dangerouslySetInnerHTML={html} />;
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

// --- tool-call body views ---------------------------------------------------

// best-effort unified diff for file-editing tools: server metadata first,
// then the input's own diff field, then synthesized fallbacks
function toolDiff(t: any): string | null {
  const st = t.state ?? {};
  const meta = st.metadata?.diff ?? st.input?.diff;
  if (typeof meta === "string" && meta.trim()) return meta;
  const name = String(t.tool ?? "").toLowerCase();
  const input = st.input ?? {};
  if (name === "write" && typeof input.content === "string") {
    // whole-file creation: every line is an addition
    const body = input.content.split("\n").map((l: string) => `+${l}`).join("\n");
    return `@@ -0,0 +1,${input.content.split("\n").length} @@\n${body}`;
  }
  if (
    typeof input.oldString === "string" ||
    (typeof input.newString === "string" && input.newString !== "")
  ) {
    const old = typeof input.oldString === "string" ? input.oldString : "";
    const neu = typeof input.newString === "string" ? input.newString : "";
    if (!old.trim() && !neu.trim()) return null;
    const del = old ? old.split("\n").map((l: string) => `-${l}`) : [];
    const add = neu ? neu.split("\n").map((l: string) => `+${l}`) : [];
    return `@@ -1,${del.length} +1,${add.length} @@\n${[...del, ...add].join("\n")}`;
  }
  return null;
}

function diffStats(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

// pretty-print JSON outputs (todowrite/task/…) — capped to protect scrolling
function prettyJson(out: string): string | null {
  if (!out.trim().startsWith("{") && !out.trim().startsWith("[")) return null;
  try {
    const parsed = JSON.parse(out);
    if (typeof parsed !== "object" || parsed === null) return null;
    const text = JSON.stringify(parsed, null, 2);
    const lines = text.split("\n");
    return lines.length > 200
      ? `${lines.slice(0, 200).join("\n")}\n… ${lines.length - 200} more lines`
      : text;
  } catch {
    return null;
  }
}

// answered question block — questions as cards, chosen answers as chips.
// any shape mismatch falls back to the raw <pre> rendering
function QuestionView({ t }: { t: any }) {
  const qs: QuestionInfo[] = Array.isArray(t.state?.input?.questions)
    ? t.state.input.questions
    : [];
  let answers: string[][] | null = null;
  try {
    const out = JSON.parse(t.state?.output ?? "");
    if (Array.isArray(out) && out.every((a) => Array.isArray(a))) answers = out;
  } catch {
    answers = null;
  }
  if (!qs.length) return null;

  const chipFor = (label: string, on: boolean) => (
    <span key={label} className={`q-chip${on ? " on" : ""}`}>
      {on && <i className="fa-solid fa-check" />}
      {label}
    </span>
  );

  return (
    <div className="q-view">
      {qs.map((q, qi) => {
        const picked = answers?.[qi] ?? [];
        const isCustom = (v: string) =>
          !!picked.includes(v) && !q.options.some((o) => o.label === v);
        return (
          <div key={qi} className="q-card">
            <div className="q-head mono">
              {q.header}
              {q.multiple && <span className="q-tag">multi</span>}
              {q.custom && <span className="q-tag">custom</span>}
            </div>
            <div className="q-text">{q.question}</div>
            <div className="q-opts">
              {q.options.map((o) => chipFor(o.label, picked.includes(o.label)))}
              {picked.filter(isCustom).map((v) => chipFor(v, true))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// one tool call — streams through pending → running → completed|error as
// part.updated replaces this part; default open/closed follows the global
// /collapse flag (errors always force-expand), eye icon toggles THIS block
function ToolBlock({ part, collapsedDefault }: { part: Part; collapsedDefault: boolean }) {
  const t = part as any;
  const st = t.state ?? {};
  const status: string = st.status ?? "";
  const [manual, setManual] = useState<boolean | null>(null);

  const out = status === "completed" ? st.output ?? "" : status === "error" ? st.error ?? "" : "";
  const outLines = out ? out.split("\n").length : 0;
  const open =
    manual ?? (status === "error" || (!collapsedDefault && outLines > 0 && outLines <= 3));

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

  // per-tool body views: git-style diff for file edits, Q&A cards for the
  // question tool, todo checklist / agent card for task tools, pretty JSON
  // for other structured outputs
  const toolName = String(t.tool ?? "").toLowerCase();
  const isEditTool = ["edit", "multiedit", "patch", "write"].includes(toolName);
  const patch = isEditTool ? toolDiff(t) : null;
  const stats = patch ? diffStats(patch) : null;
  const filePath = st.input?.filePath ?? st.input?.path ?? "";
  const pretty = status === "completed" ? prettyJson(out) : null;
  const todos = toolName === "todowrite" || toolName === "todo" ? todoSource(t) : [];
  const todoDone =
    todos.length > 0 ? todos.filter((td) => td.status === "completed").length : null;

  return (
    <div className={`tool-block ${status}${open ? " open" : ""}`}>
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
        <i className={`fa-solid ${TOOL_ICONS[(t.tool as string)?.toLowerCase()] ?? "fa-gear"} tool-ico`} />
        <span className="tool-name">{t.tool}</span>
        <span className="tool-title">{title}</span>
        {stats && (
          <span className="tool-stat mono">
            <em>+{stats.add}</em> <em className="del">−{stats.del}</em>
          </span>
        )}
        {todoDone !== null && (
          <span className="tool-stat mono">
            <em>
              ✓ {todoDone}/{todos.length}
            </em>
          </span>
        )}
        {dur && <span className="tool-dur">{dur}</span>}
        {status === "running" || status === "pending" ? (
          <i className="fa-solid fa-circle-notch fa-spin-pulse tool-state" />
        ) : status === "error" ? (
          <i className="fa-solid fa-triangle-exclamation tool-state" />
        ) : (
          <button
            type="button"
            className="tool-eye"
            data-tip={open ? "Collapse" : "Expand"}
            aria-label={open ? "Collapse tool output" : "Expand tool output"}
            onClick={(e) => {
              e.stopPropagation();
              setManual(!open);
            }}
          >
            <i className={`fa-solid ${open ? "fa-eye" : "fa-eye-slash"}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="tool-body mono">
          {patch !== null && filePath ? (
            <>
              <DiffLines patch={patch} lang={extLang(String(filePath))} />
              {out && <pre className="tool-out">{out}</pre>}
            </>
          ) : todos.length > 0 ? (
            <TodoView todos={todos} />
          ) : toolName === "task" && out.trim() ? (
            <TaskView t={t} />
          ) : toolName === "question" &&
            Array.isArray(st.input?.questions) &&
            (st.input.questions as any[]).length > 0 ? (
            <>
              <QuestionView t={t} />
              {out && !QuestionAnswered(t) && (
                <pre className="tool-out">
                  <Hi text={out} />
                </pre>
              )}
            </>
          ) : (
            <>
              {input.length > 0 && (
                <pre className="tool-input">
                  <Hi
                    text={input
                      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
                      .join("\n")}
                  />
                </pre>
              )}
              {out && (
                <pre className="tool-out">
                  <Hi text={pretty ?? out} />
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// answered? — hides the raw answers JSON once QuestionView renders it as chips
function QuestionAnswered(t: any): boolean {
  try {
    const parsed = JSON.parse(t.state?.output ?? "");
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

// todo checklist — live list from the tool's input, history fallback from its
// output; empty/unknown shape falls back to the raw <pre> rendering
type Todo = { content: string; status?: string; priority?: string };

function todoSource(t: any): Todo[] {
  const fromInput = t.state?.input?.todos;
  if (Array.isArray(fromInput)) return fromInput as Todo[];
  try {
    const out = JSON.parse(t.state?.output ?? "");
    const list = Array.isArray(out) ? out : Array.isArray(out?.todos) ? out.todos : null;
    if (list && list.every((x: any) => typeof x?.content === "string")) return list;
  } catch {
    // fall through
  }
  return [];
}

function TodoView({ todos }: { todos: Todo[] }) {
  return (
    <div className="todo-view">
      {todos.map((td, i) => (
        <div key={i} className={`todo-row ${td.status ?? ""}`}>
          <i
            className={`fa-solid ${
              td.status === "completed"
                ? "fa-circle-check"
                : td.status === "in_progress"
                  ? "fa-circle-dot todo-live"
                  : "fa-circle"
            }`}
          />
          <span className="todo-text">{td.content}</span>
          {td.priority && <span className="q-tag">{td.priority}</span>}
        </div>
      ))}
    </div>
  );
}

// subagent run — agent chip + description, report rendered as prose
function TaskView({ t }: { t: any }) {
  const st = t.state ?? {};
  let report = st.output ?? "";
  try {
    const parsed = JSON.parse(report);
    report =
      typeof parsed === "string"
        ? parsed
        : typeof parsed?.text === "string"
          ? parsed.text
          : typeof parsed?.content === "string"
            ? parsed.content
            : report;
  } catch {
    // plain text already
  }
  const agent = st.input?.subagentType ?? st.input?.agent;
  return (
    <div className="task-view">
      {agent && <span className="q-tag mono">{agent}</span>}
      {st.input?.description && <div className="q-text task-desc">{st.input.description}</div>}
      {report.trim() && <div className="task-report">{report}</div>}
    </div>
  );
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
      {msgs.map((m) =>
        m.parts.some((p) => renderPart(p, 0, collapsed)) || m.info.role === "user" ? (
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
            {m.parts.map((part, i) => renderPart(part, i, collapsed))}
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
