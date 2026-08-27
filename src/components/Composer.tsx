import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ProviderGroup } from "../types";
import { prettySize, iconFor } from "../lib/attachments";
import type { CmdEntry } from "../hooks/useOpencode";
import { splitModel } from "../lib/models";
import { useAttachments } from "../hooks/useAttachments";
import { detectLang, escPlain, hlHtml, insertFenced, looksLikeCode } from "../lib/syntax";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import SlashMenu from "./SlashMenu";
import { playSound } from "../lib/sounds";
import "../styles/composer.css";

// rebuild the draft as HTML for the highlight layer behind the textarea:
// fenced blocks get hljs coloring, fence markers dim, prose escapes plain.
// Output preserves every character (incl. newlines) so glyphs align with
// the textarea exactly.
function draftHtml(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;
  // index of a blank line already swallowed by a block's trailing side, so
  // the NEXT block doesn't claim the same line as its leading gap
  let consumedBlankAt = -1;
  while (i < lines.length) {
    const open = /^```(.*)$/.exec(lines[i]);
    if (!open) {
      // blank line sitting right above a fence belongs to the block's slab:
      // skip emitting it here — the block span owns this newline instead
      if (
        lines[i] === "" &&
        i + 1 < lines.length &&
        /^```/.test(lines[i + 1])
      ) {
        i++;
        continue;
      }
      out.push(escPlain(lines[i]));
      if (i < lines.length - 1) out.push("\n");
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !/^```/.test(lines[j])) j++;
    const closed = j < lines.length;
    const body = lines.slice(i + 1, closed ? j : lines.length).join("\n");
    const lang = open[1].trim();
    // blank line directly above the fence joins the slab so the background
    // runs continuously through the paragraph gap (insertFenced adds one)
    const leadBlank =
      i > 0 && lines[i - 1] === "" && i - 1 !== consumedBlankAt;
    // one wrapper span around markers + body (+ adjacent blank lines) so the
    // whole fenced region paints as a single delimited block
    out.push(
      `<span class="comp-codeblock">${leadBlank ? "\n" : ""}<span class="comp-fence">${escPlain(
        lines[i],
      )}${i < lines.length - 1 ? "\n" : ""}</span>${hlHtml(body, lang || undefined)}${
        closed ? "\n" : ""
      }`,
    );
    if (closed) {
      out.push(`<span class="comp-fence">${escPlain(lines[j])}`);
      if (j < lines.length - 1) out.push("\n");
      // same for the blank line below — but never the phantom trailing
      // element of a source ending in "\n"
      if (j + 1 < lines.length - 1 && lines[j + 1] === "") {
        out.push("\n");
        consumedBlankAt = j + 1;
        i = j + 2;
      } else {
        i = j + 1;
      }
      out.push("</span></span>");
    } else {
      i = lines.length;
      out.push("</span>");
    }
  }
  return out.join("");
}

export default function Composer({
  busy,
  escHint,
  clearEscHint,
  loadingModels,
  providers,
  modelSel,
  defaultModel,
  onModelSelect,
  onSend,
  onAbort,
  onToggleDiff,
  onToggleTerm,
  onPickWorkspace,
  workspace,
  commands,
  onCommandsOpen,
  agents,
  agentSel,
  onCycleAgent,
  onCycleVariant,
  hasVariants,
  variantSel,
  usage,
  caps,
   voicePhase,
  voiceStreaming,
  voiceError,
  onVoiceToggle,
}: {
  busy: boolean;
  // double-Escape stop gesture armed — the stop button shows its countdown
  escHint?: boolean;
  clearEscHint?: () => void;
  loadingModels?: boolean;
  providers: ProviderGroup[];
  modelSel: string;
  defaultModel?: string;
  onModelSelect: (value: string) => void;
  onSend: (text: string, files?: Attachment[]) => void;
  onAbort: () => void;
  onToggleDiff?: () => void;
  onToggleTerm?: () => void;
  onPickWorkspace?: () => void;
  workspace?: string;
  commands?: CmdEntry[];
  onCommandsOpen?: () => void;
  agents?: { name: string; mode: string }[];
  agentSel?: string;
  onCycleAgent?: () => void;
  onCycleVariant?: () => void;
  hasVariants?: boolean;
  variantSel?: string;
  caps?: { attachment?: boolean; input?: string[] };
  usage?: { cost: number; tokens: number };
  voicePhase?: "idle" | "recording" | "transcribing";
  voiceStreaming?: boolean;
  voiceError?: string;
  onVoiceToggle?: () => void;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1); // keyboard highlight index
  const [hiCmd, setHiCmd] = useState(0); // slash-menu highlight
  const [cmdClosed, setCmdClosed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);

  // live highlight layer: rebuilt synchronously. Plain text bypasses the
  // overlay entirely (hasCode gate) so many newlines never drift; code
  // blocks keep the trailing "\n" sentinel to make pre-wrap render the last
  // empty line (textarea shows it natively).
  const markup = useMemo(() => {
    if (!input) return "";
    const base = draftHtml(input);
    const needsSentinel = base.includes("comp-codeblock") && /\n$/.test(input);
    return needsSentinel ? base + "\n" : base;
  }, [input]);
  const hasCode = markup.includes("comp-codeblock");

  // the composer used to be drag-resizable (oc.comp.h) — clear any stale
  // stored height so old installs fall back to auto sizing
  useEffect(() => {
    localStorage.removeItem("oc.comp.h");
  }, []);

  // auto-grow: the whole input follows its line count — the textarea (and
  // with it the entire composer card) expands until half the window, then
  // scrolls internally
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const max = Math.round(window.innerHeight * 0.5);
    el.style.height = "auto";
    // border is 1px top+bottom inside border-box, scrollHeight excludes it → +2 avoids 1px overflow that shows a scrollbar on one line
    const border = el.offsetHeight - el.clientHeight;
    const h = Math.max(46, Math.min(el.scrollHeight + border, max));
    el.style.height = `${h}px`;
    // single line (or any fits) → no scrollbar at all; only scroll when capped at max
    el.style.overflowY = el.scrollHeight + border > max ? "auto" : "hidden";
  }, [input]);

  // keep highlight overlay scroll in sync — onScroll alone misses auto-grow
  // height changes (many newlines -> permanent offset)
  useEffect(() => {
    if (hlRef.current && inputRef.current) {
      hlRef.current.scrollTop = inputRef.current.scrollTop;
      hlRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  }, [input, markup]);

  const attach = useAttachments();

  // no selection and the server default is still unknown → require a pick
  const needsModel = !loadingModels && !modelSel && !defaultModel;

  // slash-command autocomplete: active while typing the leading /token only
  // (no space yet) — file paths etc. never trigger it
  const slashQ = /^\/([\w-]*)$/.exec(input)?.[1] ?? null;
  useEffect(() => {
    setCmdClosed(false);
    setHiCmd(0);
  }, [slashQ]);
  const cmdEntries = useMemo(() => {
    if (!commands) return [];
    const q = (slashQ ?? "").toLowerCase();
    return commands
      .filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [slashQ, commands]);
  const cmdOpen = slashQ !== null && !cmdClosed && cmdEntries.length > 0;
  useEffect(() => {
    if (cmdOpen) onCommandsOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdOpen]);

  // /models command → open the model picker
  useEffect(() => {
    const openEvt = () => {
      if (loadingModels) return;
      setOpen(true);
      setHi(entries.findIndex((e2) => e2.value === modelSel));
    };
    window.addEventListener("oc:models", openEvt);
    return () => window.removeEventListener("oc:models", openEvt);
  });

  // voice dictation events (dispatched by useVoice routing in ChatPage):
  // "prompt …" text lands in the textarea for review, "send …" fills and
  // submits at once (single event so the draft can't be stale), bare
  // "send it" fires the real send on whatever is staged
  useEffect(() => {
    const onText = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      playSound("type");
      inputRef.current?.focus();
    };
    const onSend = () => send();
    const onSendText = (e: Event) => {
      const add = ((e as CustomEvent<string>).detail ?? "").trim();
      if (!add) return;
      sendWith(input ? `${input} ${add}` : add);
    };
    const onClear = () => {
      setInput("");
      inputRef.current?.focus();
    };
    window.addEventListener("oc:voice-text", onText);
    window.addEventListener("oc:voice-send", onSend);
    window.addEventListener("oc:voice-send-text", onSendText);
    window.addEventListener("oc:voice-clear", onClear);
    return () => {
      window.removeEventListener("oc:voice-text", onText);
      window.removeEventListener("oc:voice-send", onSend);
      window.removeEventListener("oc:voice-send-text", onSendText);
      window.removeEventListener("oc:voice-clear", onClear);
    };
  });

  // ONE keyboard brain for the composer: a fresh closure every render, so
  // every surface (model menu, slash suggestions, agent Tab-cycle, send)
  // routes off the same state — no per-handler desync.
  // priority: model menu → slash suggestions → plain Enter send / Tab cycle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // --- model picker open: owns navigation from anywhere ---
      if (open) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHi((h) => Math.min(h + 1, entries.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHi((h) => Math.max(h - 1, 0));
        } else if (e.key === "Home") {
          e.preventDefault();
          setHi(0);
        } else if (e.key === "End") {
          e.preventDefault();
          setHi(entries.length - 1);
        } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
          e.preventDefault();
          const c = entries[Math.max(0, Math.min(hi, entries.length - 1))];
          if (c) pick(c.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          setHi(-1);
        }
        return;
      }

      // --- slash suggestions visible: arrows move, Tab completes,
      //     Enter runs arg-less commands instantly ---
      if (cmdOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHiCmd((h) => Math.min(h + 1, cmdEntries.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setHiCmd((h) => Math.max(h - 1, 0));
        } else if (e.key === "Tab") {
          e.preventDefault();
          const c = cmdEntries[Math.max(0, Math.min(hiCmd, cmdEntries.length - 1))];
          if (c) fillCmd(c);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          cmdPick();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setCmdClosed(true);
        }
        return;
      }

      // --- Enter in the textarea sends ---
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        e.target === inputRef.current
      ) {
        e.preventDefault();
        send();
        return;
      }

      // --- Tab cycles the agent when no suggestion UI is up;
      //     real form fields keep Tab's focus behavior ---
      if (
        e.key === "Tab" &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.shiftKey
      ) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
        e.preventDefault();
        onCycleAgent?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fillCmd = (c: CmdEntry) => {
    setInput(`/${c.name} `);
  };
  const runCmd = (c: CmdEntry) => {
    setInput("");
    playSound("send");
    onSend(`/${c.name}`);
  };

  const pretty = (sel: string) => {
    const [pid, mid] = splitModel(sel);
    const g = providers.find((x) => x.id === pid);
    const m = g?.models.find((x) => x.id === mid);
    return g && m ? `${g.label} · ${m.label}` : sel;
  };

  // flat selectable entries (server default first, then provider models)
  const allEntries: ModelEntry[] = [];
  if (defaultModel) {
    allEntries.push({ value: "", label: `Server default · ${pretty(defaultModel)}` });
  }
  providers.forEach((g) =>
    g.models.forEach((m) =>
      allEntries.push({ value: `${g.id}/${m.id}`, label: m.label, group: g.label }),
    ),
  );

  // model-menu filter: keyboard brain navigates the FILTERED list, so
  // highlight indices always match what's on screen
  const [mq, setMq] = useState("");
  const q = mq.trim().toLowerCase();
  const entries: ModelEntry[] = q
    ? allEntries.filter(
        (e2) =>
          e2.label.toLowerCase().includes(q) ||
          e2.value.toLowerCase().includes(q) ||
          (e2.group ?? "").toLowerCase().includes(q),
      )
    : allEntries;
  // typing restarts highlight from the top of the results
  useEffect(() => {
    if (open) setHi(q ? 0 : allEntries.findIndex((e2) => e2.value === modelSel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  // stale query would leak into the next open
  useEffect(() => {
    if (!open) setMq("");
  }, [open]);

  function pick(v: string) {
    onModelSelect(v);
    setOpen(false);
    setHi(-1);
  }

  const currentLabel = () => {
    if (loadingModels) return "loading models…";
    if (needsModel) return "choose a model to start";
    if (modelSel) return pretty(modelSel);
    return `${pretty(defaultModel ?? "")} (server default)`;
  };

  const send = () => sendWith(input);

  const sendWith = (t: string) => {
    const text = t.trim();
    const ready = attach.readyFiles();
    if ((!text && !ready.length) || needsModel) return;
    setInput("");
    attach.clearFiles();
    attach.setNote("");
    playSound("send");
    onSend(text, ready.length ? ready : undefined);
  };

  // slash menu: Enter picks the highlighted entry — arg-less commands send
  // right away, arg-taking ones fill the input so arguments can be typed
  const cmdPick = () => {
    const c = cmdEntries[Math.max(0, Math.min(hiCmd, cmdEntries.length - 1))];
    if (!c) return;
    if (c.takesArgs) fillCmd(c);
    else runCmd(c);
  };

  return (
    <div
      className={`composer${attach.dragOver ? " dragover" : ""}`}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        attach.setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        attach.setDragOver(false);
      }}
      onDrop={(e) => {
        attach.setDragOver(false);
        e.preventDefault();
        attach.addFiles(e.dataTransfer.files);
      }}
    >
      <div className="model-row">
        <span>{currentLabel()}</span>
        {onCycleAgent && agents && (
          <button
            type="button"
            className="agent-chip"
            data-tip={`Agent — Tab to cycle (${agents.length} available)`}
            onClick={() => onCycleAgent()}
          >
            <i className="fa-solid fa-robot" />
            {agentSel || agents[0]?.name || "build"}
          </button>
        )}
        {(variantSel || hasVariants) && (
          <button
            type="button"
            className="agent-chip"
            data-tip={`Thinking effort: ${variantSel || "default"} — click to cycle`}
            onClick={() => onCycleVariant?.()}
          >
            <i className="fa-solid fa-gauge-high" />
            {variantSel || "default"}
          </button>
        )}
        {usage && usage.tokens > 0 && (
          <span
            className="agent-chip usage-chip"
            data-tip={`Session totals — ${usage.tokens.toLocaleString()} tokens${usage.cost > 0 ? `, $${usage.cost.toFixed(4)}` : ""}`}
          >
            <i className="fa-solid fa-coins" />
            {usage.tokens >= 1000 ? `${(usage.tokens / 1000).toFixed(usage.tokens >= 10000 ? 0 : 1)}k` : usage.tokens} tok
            {usage.cost > 0 && ` · $${usage.cost.toFixed(4)}`}
          </span>
        )}
        <ModelMenu
          open={open}
          setOpen={setOpen}
          hi={hi}
          setHi={setHi}
          entries={entries}
          query={mq}
          setQuery={setMq}
          selected={modelSel}
          label={currentLabel()}
          disabled={loadingModels}
          needsModel={needsModel}
          onPick={pick}
        />
        {onPickWorkspace && (
          <button
            type="button"
            className="icon-btn diff-btn"
            data-tip={`Workspace: ${workspace || "home folder"} — click to change (Ctrl+O)`}
            onClick={onPickWorkspace}
          >
            <i className="fa-solid fa-folder-open" />
          </button>
        )}
        {onToggleDiff && (
          <button
            type="button"
            className="icon-btn diff-btn"
            data-tip="Files changed in this session"
            onClick={onToggleDiff}
          >
            <i className="fa-solid fa-code-compare" />
          </button>
        )}
        {onToggleTerm && (
          <button
            type="button"
            className="icon-btn diff-btn"
            data-tip="Terminal (Ctrl+`)"
            onClick={onToggleTerm}
          >
            <i className="fa-solid fa-terminal" />
          </button>
        )}
      </div>
      {cmdOpen && (
        <SlashMenu entries={cmdEntries} hi={hiCmd} onHover={setHiCmd} onPick={(c) => (c.takesArgs ? fillCmd(c) : runCmd(c))} />
      )}
      {(attach.files.length > 0 || attach.note) && (
        <div className="attach-row">
          {attach.files.map((a) => (
            <div key={a.id} className={`attach-chip${a.status === "reading" ? " reading" : ""}`}>
              {a.mime.startsWith("image/") && a.url ? (
                <img src={a.url} alt="" />
              ) : (
                <i className={`fa-solid ${iconFor(a.mime)} attach-icon`} />
              )}
              <span className="attach-name">{a.filename}</span>
              <span className="attach-size">{prettySize(a.size)}</span>
              <button
                type="button"
                className="attach-x"
                data-tip="Remove attachment"
                onClick={() => attach.removeFile(a.id)}
              >
                <i className="fa-solid fa-xmark" />
              </button>
              {a.status === "reading" && (
                <i className="attach-bar" style={{ width: `${Math.round(a.progress * 100)}%` }} />
              )}
            </div>
          ))}
        </div>
      )}
      {attach.note && <div className="composer-note">{attach.note}</div>}
      {!attach.note && voiceError && <div className="composer-note">{voiceError}</div>}
      <div className="composer-row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach.addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="comp-tools">
          <button
            type="button"
            className="icon-btn diff-btn attach-btn"
            data-tip={
              caps?.input?.length && !caps.input.includes("image") && !caps.input.includes("video")
                ? `Attach files — this model reports: ${caps.input.join(", ")}`
                : "Attach files"
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <i className="fa-solid fa-paperclip" />
          </button>
          {onVoiceToggle && (
            <button
              type="button"
              className={`icon-btn diff-btn mic-btn${
                voicePhase === "recording" || voiceStreaming ? " recording" : ""
              }`}
              data-tip={
                voiceError ||
                (voicePhase === "transcribing"
                  ? "Transcribing…"
                  : voiceStreaming
                    ? "Hands-free listening… pause to review, then say 'envoyé' / 'send it' — click to stop"
                    : voicePhase === "recording"
                      ? "Recording… click to transcribe"
                      : "Voice input — dictate a prompt or say 'new session', 'theme latte', 'run compact'…")
              }
              disabled={voicePhase === "transcribing" && !voiceStreaming}
              onClick={onVoiceToggle}
            >
              <i
                className={`fa-solid ${
                  voicePhase === "transcribing" ? "fa-spinner fa-spin" : "fa-microphone"
                }`}
              />
            </button>
          )}
        </div>
        <div className={`comp-input${hasCode ? " has-code" : ""}`}>
          {hasCode && (
            <div
              ref={hlRef}
              className="comp-hl"
              aria-hidden
              dangerouslySetInnerHTML={{ __html: markup }}
            />
          )}
          <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  disabled={needsModel}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    const fs = e.clipboardData?.files;
                    if (fs?.length) {
                      e.preventDefault();
                      attach.addFiles(fs);
                      return;
                    }
                    // code-shaped pastes land as fenced, highlighted blocks
                    const text = e.clipboardData?.getData("text/plain");
                    const el = e.currentTarget;
                    if (text && looksLikeCode(text)) {
                      e.preventDefault();
                      const { text: next, caret } = insertFenced(
                        el.value,
                        el.selectionStart ?? el.value.length,
                        el.selectionEnd ?? el.value.length,
                        text,
                        detectLang(text),
                      );
                      setInput(next);
                      playSound("type");
                      requestAnimationFrame(() => {
                        el.selectionStart = el.selectionEnd = caret;
                      });
                    }
                  }}
                  onScroll={(e) => {
                    if (hlRef.current) {
                      hlRef.current.scrollTop = e.currentTarget.scrollTop;
                      hlRef.current.scrollLeft = e.currentTarget.scrollLeft;
                    }
                  }}
                  onKeyDown={(e) => {
                    // typing sounds only — all key ROUTING (menus, send,
                    // agent cycle) lives in the single global handler
                    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                      if (e.key === "Backspace" || e.key === "Delete") playSound("erase");
                      else if (e.key === "Enter" && e.shiftKey) playSound("newline");
                      else if (e.key.length === 1) playSound("type");
                    }
                  }}
                  placeholder={
                    needsModel
                      ? "Pick a model above to start chatting"
                      : busy
                        ? "Waiting for reply…"
                        : "Ask anything (Enter to send, Shift+Enter for newline)"
                  }
                />
          </div>
                {busy ? (
                  <button
                    className={`stop-btn${escHint ? " armed" : ""}`}
                    data-tip={escHint ? "Press Esc again to stop" : "Stop generating"}
                    onClick={() => {
                      clearEscHint?.();
                      onAbort();
                    }}
                  >
                    <i className="fa-solid fa-stop" />
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    data-tip="Send · Enter"
                    onClick={send}
                    disabled={(!input.trim() && !attach.readyFiles().length) || needsModel}
                  >
                    <i className="fa-solid fa-paper-plane" />
                  </button>
                )}
              </div>
    </div>
  );
}

