import { useMemo, useState } from "react";
import type { Part } from "@opencode-ai/sdk/client";
import type { QuestionInfo } from "../types";
import { hlHtml, extLang } from "../lib/syntax";
import { DiffLines } from "./DiffPanel";

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

// one tool call — streams through pending → running → completed|error as
// part.updated replaces this part; default open/closed follows the global
// /collapse flag (errors always force-expand), eye icon toggles THIS block
export default function ToolBlock({ part, collapsedDefault }: { part: Part; collapsedDefault: boolean }) {
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
