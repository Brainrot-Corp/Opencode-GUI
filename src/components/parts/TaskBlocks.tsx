import { useContext, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { mdComponents, fmtTok } from "./mdParts";
import { PartCtx } from "../ToolBlock";

// <task id="..." state="completed"><task_result>...markdown...</task_result></task>
// appears as a fenced perl block in text parts. Render it like other tool
// calls — tool-block chrome with markdown body instead of raw XML/dump.
export const TASK_RE = /(?:```\w*\s*)?<task\b[^>]*>[\s\S]*?<\/task>(?:\s*```)?/gi;

export function extractTaskEntries(text: string): { id?: string; state?: string; result: string; raw: string }[] | null {
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

export function TaskResultBlock({
  id,
  state,
  result,
}: {
  id?: string;
  state?: string;
  result: string;
}) {
  const { collapsedDefault, taskCosts, onOpenSubagent } = useContext(PartCtx);
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

export function TaskMixed({ text }: { text: string }) {
  const parts: ReactNode[] = [];
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

// subtask / agent part — name + description in the tool-head chrome, prompt
// body collapsible; the chevron opens the subagent's child transcript
export function SubtaskBlock({ part }: { part: any }) {
  const { collapsedDefault, onOpenSubagent } = useContext(PartCtx);
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
