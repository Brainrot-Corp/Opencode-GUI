import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ProviderGroup } from "../types";
import { prettySize, iconFor } from "../lib/attachments";
import type { CmdEntry } from "../hooks/useOpencode";
import { splitModel } from "../lib/models";
import { useAttachments } from "../hooks/useAttachments";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import SlashMenu from "./SlashMenu";
import { playSound } from "../lib/sounds";
import "../styles/composer.css";

export default function Composer({
  busy,
  loadingModels,
  providers,
  modelSel,
  defaultModel,
  onModelSelect,
  onSend,
  onAbort,
  onToggleDiff,
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
  loadingModels?: boolean;
  providers: ProviderGroup[];
  modelSel: string;
  defaultModel?: string;
  onModelSelect: (value: string) => void;
  onSend: (text: string, files?: Attachment[]) => void;
  onAbort: () => void;
  onToggleDiff?: () => void;
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

  // y-resize: explicit composer height in px, 0 = auto. Dragging the top edge
  // grows the input and shrinks the chat history (flex sibling). Persisted
  // under oc.comp.h; double-click the handle to return to auto.
  const [h, setH] = useState(() => {
    const v = Number(localStorage.getItem("oc.comp.h"));
    return v >= 112 && v <= 3000 ? v : 0;
  });
  const compRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; h: number; min: number } | null>(null);

  useEffect(() => {
    if (h) localStorage.setItem("oc.comp.h", String(h));
    else localStorage.removeItem("oc.comp.h");
  }, [h]);

  // auto-grow: the whole input follows its line count — the textarea (and
  // with it the entire composer card) expands until half the window, then
  // scrolls internally. Skipped in manual-height mode — there the row
  // stretch owns the textarea's size, so a stale inline height would fight it
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (h) {
      el.style.height = "";
      return;
    }
    const max = Math.round(window.innerHeight * 0.5);
    el.style.height = "auto";
    // floor at the single-line rest height so the box never sits below it
    el.style.height = `${Math.max(46, Math.min(el.scrollHeight, max))}px`;
  }, [input, h]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = compRef.current;
    // natural auto-flow height = the perfect minimum: at it the textarea
    // rests at one line, its top/bottom edges flush with the send button.
    // Measured once per drag with the explicit height cleared (synchronous,
    // so no flicker)
    const saved = el?.style.height ?? "";
    if (el) el.style.height = "";
    const min = el?.offsetHeight || 200;
    if (el) el.style.height = saved;
    dragRef.current = { y: e.clientY, h: h || min, min };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const max = Math.round(window.innerHeight * 0.72);
      setH(
        Math.min(
          Math.max(dragRef.current.h - (ev.clientY - dragRef.current.y), dragRef.current.min),
          max,
        ),
      );
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // hiding/minimizing mid-drag eats the mouseup — end the drag on blur
    window.addEventListener("blur", up);
  };

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
      ref={compRef}
      className={`composer${attach.dragOver ? " dragover" : ""}${h ? " resized" : ""}${
        h >= 140 ? " tall" : ""
      }`}
      style={h ? { height: h } : undefined}
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
      <div
        className="comp-resize"
        data-tip="Drag to resize · double-click to reset"
        onMouseDown={startResize}
        onDoubleClick={() => setH(0)}
      />
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
            data-tip={`Workspace: ${workspace || "home folder"} — click to change`}
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
        <textarea
                  ref={inputRef}
                  value={input}
                  disabled={needsModel}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    const fs = e.clipboardData?.files;
                    if (fs?.length) {
                      e.preventDefault();
                      attach.addFiles(fs);
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
                {busy ? (
                  <button className="stop-btn" onClick={onAbort}>
                    <i className="fa-solid fa-stop" />
                    Stop
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    onClick={send}
                    disabled={(!input.trim() && !attach.readyFiles().length) || needsModel}
                  >
                    Send
                    <i className="fa-solid fa-paper-plane" />
                  </button>
                )}
              </div>
    </div>
  );
}

