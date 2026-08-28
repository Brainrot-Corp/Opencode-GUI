import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment, ProviderGroup } from "../types";
import { prettySize, iconFor } from "../lib/attachments";
import type { CmdEntry } from "../hooks/useOpencode";
import { splitModel } from "../lib/models";
import { useAttachments } from "../hooks/useAttachments";
import { detectLang, escPlain, hlHtml, insertFenced, looksLikeCode } from "../lib/syntax";
import { handleComposerKeys } from "../lib/editorKeys";
import { findMatches, highlightFindInHtml } from "../lib/find";
import { matchesEvent } from "../lib/hotkeys";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import SlashMenu from "./SlashMenu";
import { playSound } from "../lib/sounds";
import { getDraft, setDraft } from "../lib/drafts";
import { getRecentModels, pushRecentModel } from "../lib/recentModels";
import "../styles/composer.css";
import "../styles/find.css";

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
  sessionId,
  cycleAgentHotkey,
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
  sessionId?: string;
  cycleAgentHotkey?: string | null;
}) {
  const [input, setInput] = useState(() => getDraft(sessionId ?? ""));
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1); // keyboard highlight index
  const [hiCmd, setHiCmd] = useState(0); // slash-menu highlight
  const [cmdClosed, setCmdClosed] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => getRecentModels());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const isUndoRedoRef = useRef(false);
  const inputRef2 = useRef(input);
  inputRef2.current = input;

  // find state — overlay highlights all matches, active one opaque
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findCur, setFindCur] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;

  const compMatches = useMemo(
    () => findMatches(input, findQuery, findCase),
    [input, findQuery, findCase],
  );
  // reset current when query changes
  useEffect(() => { setFindCur(0); }, [findQuery, findCase]);
  // keep cur in bounds when text changes
  useEffect(() => {
    if (compMatches.length === 0) setFindCur(0);
    else if (findCur >= compMatches.length) setFindCur(compMatches.length - 1);
  }, [compMatches.length, findCur]);

  // live highlight layer: rebuilt synchronously. Plain text bypasses the
  // overlay entirely (hasCode gate) so many newlines never drift; code
  // blocks keep the trailing "\n" sentinel to make pre-wrap render the last
  // empty line (textarea shows it natively).
  const rawMarkup = useMemo(() => {
    if (!input) return "";
    const base = draftHtml(input);
    const needsSentinel = base.includes("comp-codeblock") && /\n$/.test(input);
    return needsSentinel ? base + "\n" : base;
  }, [input]);
  const hasCode = rawMarkup.includes("comp-codeblock");
  const hasFind = findOpen && findQuery.length > 0;
  const hasOverlay = (hasCode || hasFind) && input.length > 0;
  const markup = useMemo(() => {
    if (!input) return "";
    let base = rawMarkup;
    // when find is active but no code block, base is still plain escaped text
    // draftHtml already produced it; if somehow empty (plain without code, still has content)
    // rawMarkup is non-empty. For safety, if no code and we need find, ensure base
    // mirrors textarea plain text.
    if (hasFind && !hasCode) {
      // draftHtml for plain text already is escPlain lines; but if codeuhi
      // For find-only, we want full plain html to highlight
      // rawMarkup already is that (or empty if input empty which we early returned)
    }
    if (hasFind && findQuery) {
      // ponytail: highlight counts from raw text indices but injected by scanning
      // html text nodes — misses cross-token boundaries, ok for single-token queries
      base = highlightFindInHtml(base, findQuery, findCase, findCur);
    }
    return base;
  }, [input, rawMarkup, hasFind, hasCode, findQuery, findCase, findCur]);

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

  // per-session draft: input is restored when returning to a session
  const suppressSaveRef = useRef(false);
  const sidRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId === sidRef.current) return;
    sidRef.current = sessionId;
    suppressSaveRef.current = true;
    setInput(getDraft(sessionId ?? ""));
    setFindOpen(false);
    // next tick allow saving again — avoids saving old input under new sid
    queueMicrotask(() => {
      suppressSaveRef.current = false;
    });
  }, [sessionId]);
  useEffect(() => {
    if (suppressSaveRef.current) return;
    if (!sessionId) return;
    setDraft(sessionId, input);
  }, [input, sessionId]);

  // discord presence — typing indicator (app-launch timer lives in plugin)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("oc:composer-draft", { detail: input.trim().length > 0 }));
  }, [input]);

  // history for undo/redo of line ops (cut etc.) — also covers typing
  const prevInputRef = useRef(input);
  useEffect(() => {
    if (isUndoRedoRef.current) {
      prevInputRef.current = input;
      return;
    }
    if (prevInputRef.current === input) return;
    if (suppressSaveRef.current) {
      prevInputRef.current = input;
      historyRef.current = [];
      futureRef.current = [];
      return;
    }
    historyRef.current.push(prevInputRef.current);
    if (historyRef.current.length > 200) historyRef.current.shift();
    futureRef.current = [];
    prevInputRef.current = input;
  }, [input]);

  const undoComposer = () => {
    const h = historyRef.current;
    if (!h.length) return false;
    const prev = h.pop()!;
    futureRef.current.push(inputRef2.current);
    isUndoRedoRef.current = true;
    setInput(prev);
    requestAnimationFrame(() => {
      isUndoRedoRef.current = false;
      const ta = inputRef.current;
      if (ta) {
        ta.focus();
        try { const p = Math.min(ta.selectionStart ?? 0, prev.length); ta.setSelectionRange(p, p); } catch {}
      }
    });
    return true;
  };
  const redoComposer = () => {
    const f = futureRef.current;
    if (!f.length) return false;
    const next = f.pop()!;
    historyRef.current.push(inputRef2.current);
    isUndoRedoRef.current = true;
    setInput(next);
    requestAnimationFrame(() => {
      isUndoRedoRef.current = false;
      const ta = inputRef.current;
      if (ta) {
        ta.focus();
        try { const p = Math.min(ta.selectionStart ?? 0, next.length); ta.setSelectionRange(p, p); } catch {}
      }
    });
    return true;
  };

  const gotoFind = (idx: number) => {
    if (!compMatches.length) return;
    const j = ((idx % compMatches.length) + compMatches.length) % compMatches.length;
    setFindCur(j);
    const ta = inputRef.current;
    if (!ta) return;
    const start = compMatches[j];
    const qlen = findQuery.length;
    ta.focus();
    try { ta.setSelectionRange(start, start + qlen); } catch {}
    // center line in view
    const lh = 21;
    const line = (input.slice(0, start).match(/\n/g) ?? []).length;
    try {
      ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
      if (hlRef.current) {
        hlRef.current.scrollTop = ta.scrollTop;
        hlRef.current.scrollLeft = ta.scrollLeft;
      }
    } catch {}
  };

  const openFind = () => {
    const ta = inputRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const sel = input.slice(ta.selectionStart, ta.selectionEnd);
      // avoid seeding with multiline selection > 120 chars
      if (sel && sel.length <= 120 && !sel.includes("\n")) setFindQuery(sel);
    }
    setFindOpen(true);
    setFindCur(0);
    requestAnimationFrame(() => findInputRef.current?.select());
    window.dispatchEvent(new CustomEvent("oc:find-opened", { detail: "composer" }));
  };
  const closeFind = () => {
    setFindOpen(false);
    inputRef.current?.focus();
  };

  // routed via ChatPage central Ctrl+F — listen for dispatched event
  useEffect(() => {
    const onFind = () => {
      if (findOpenRef.current) {
        findInputRef.current?.focus();
        findInputRef.current?.select();
        return;
      }
      openFind();
    };
    window.addEventListener("oc:composer-find", onFind);
    return () => window.removeEventListener("oc:composer-find", onFind);
  });
  // close when another find tool opens
  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== "composer" && findOpenRef.current) setFindOpen(false);
    };
    window.addEventListener("oc:find-opened", onOther as EventListener);
    return () => window.removeEventListener("oc:find-opened", onOther as EventListener);
  });
  // close when clicking outside the find bar
  useEffect(() => {
    if (!findOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".comp-find")) return;
      setFindOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [findOpen]);

  // when find is open, Esc closes it; Enter navigates
  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    } else if (e.key === "Enter") {
      e.preventDefault();
      gotoFind(findCur + (e.shiftKey ? -1 : 1));
    }
  };

  const attach = useAttachments();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [preview]);

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

  // rewind: paste the cut-off conversation into the input for editing
  useEffect(() => {
    const onRewind = (e: Event) => {
      const text = (e as CustomEvent<string>).detail ?? "";
      if (!text) return;
      setInput(text);
      playSound("type");
      // focus and move caret to end
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const len = text.length;
        try { el.selectionStart = el.selectionEnd = len; } catch {}
      });
    };
    window.addEventListener("oc:rewind-input", onRewind);
    return () => window.removeEventListener("oc:rewind-input", onRewind);
  }, []);

  // ONE keyboard brain for the composer: a fresh closure every render, so
  // every surface (model menu, slash suggestions, agent Tab-cycle, send)
  // routes off the same state — no per-handler desync.
  // priority: model menu → slash suggestions → plain Enter send / Tab cycle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // find open has priority over model/slash/send
      if (findOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeFind();
          return;
        }
        if (e.key === "F3" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g")) {
          e.preventDefault();
          gotoFind(findCur + (e.shiftKey ? -1 : 1));
          return;
        }
        // typing in find input — don't steal keys
        if (e.target === findInputRef.current) return;
        // Enter in composer navigates find, not sends
        if (e.key === "Enter" && !e.shiftKey && e.target === inputRef.current && findQuery) {
          e.preventDefault();
          gotoFind(findCur + (e.shiftKey ? -1 : 1));
          return;
        }
      }
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

      // --- cycleAgent hotkey — default Tab ---
      if (onCycleAgent) {
        const b = cycleAgentHotkey ?? "Tab";
        const should = b ? matchesEvent(e as any, b) : e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        if (should) {
          const t = e.target as HTMLElement | null;
          if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) {
            // allow native tab in inputs/selects unless rebind is explicitly that
            if (b === "Tab") return;
          }
          e.preventDefault();
          onCycleAgent();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // type-to-focus: when terminal isn't focused and a session is active,
  // printable keys (and Backspace/Delete) that would otherwise go nowhere
  // focus the composer at the caret position. Shortcuts and overlays are excluded.
  useEffect(() => {
    const onTypeToFocus = (e: KeyboardEvent) => {
      if (!sessionId) return;
      const ta = inputRef.current;
      if (!ta || ta.disabled) return;
      if (document.activeElement === ta) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e as any).isComposing || e.keyCode === 229) return;
      const isPrintable = e.key.length === 1;
      const isEdit = e.key === "Backspace" || e.key === "Delete";
      if (!isPrintable && !isEdit) return;
      const target = e.target as HTMLElement | null;
      const ae = document.activeElement as HTMLElement | null;
      const isEditable = (el: HTMLElement | null) =>
        !!el && (!!el.closest?.("input, textarea, select, [contenteditable]") || (el as HTMLElement).isContentEditable);
      if (isEditable(target) || isEditable(ae)) return;
      // terminal owns its keys — only block when the dock is open (not .closed)
      const tDock = target?.closest?.(".term-dock") as HTMLElement | null;
      const aeDock = ae?.closest?.(".term-dock") as HTMLElement | null;
      const dock = tDock || aeDock;
      if (dock && !dock.classList.contains("closed")) return;
      if (ae?.closest?.(".xterm") || target?.closest?.(".xterm")) return;
      // overlays own typing — blocked per user choice
      if (document.querySelector(".cmd-menu, .model-menu, .ctx-menu, .dlg-scrim, .drawer-scrim.open, .permission-bar")) return;
      e.preventDefault();
      ta.focus();
      const cur = inputRef2.current;
      const start = ta.selectionStart ?? cur.length;
      const end = ta.selectionEnd ?? cur.length;
      let next: string;
      let caret: number;
      if (isPrintable) {
        next = cur.slice(0, start) + e.key + cur.slice(end);
        caret = start + 1;
        playSound("type");
      } else if (e.key === "Backspace") {
        if (start !== end) {
          next = cur.slice(0, start) + cur.slice(end);
          caret = start;
        } else if (start > 0) {
          next = cur.slice(0, start - 1) + cur.slice(end);
          caret = start - 1;
        } else {
          return;
        }
        playSound("erase");
      } else {
        // Delete
        if (start !== end) {
          next = cur.slice(0, start) + cur.slice(end);
          caret = start;
        } else if (start < cur.length) {
          next = cur.slice(0, start) + cur.slice(end + 1);
          caret = start;
        } else {
          return;
        }
        playSound("erase");
      }
      setInput(next);
      requestAnimationFrame(() => {
        try {
          ta.setSelectionRange(caret, caret);
        } catch {}
      });
    };
    window.addEventListener("keydown", onTypeToFocus);
    return () => window.removeEventListener("keydown", onTypeToFocus);
  }, [sessionId]);

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

  // keep recent list in sync when model changes externally (voice, restore)
  useEffect(() => {
    if (!modelSel || !providers.length) return;
    if (recent[0] === modelSel) return;
    const valid = providers.some((g) => g.models.some((m) => `${g.id}/${m.id}` === modelSel));
    if (!valid) return;
    const next = pushRecentModel(modelSel);
    if (next.join("|") !== recent.join("|")) setRecent(next);
  }, [modelSel, providers, recent]);

  // flat selectable entries: recent (5) on top, then server default, then provider models (deduped)
  const allEntries: ModelEntry[] = useMemo(() => {
    const out: ModelEntry[] = [];
    if (recent.length && providers.length) {
      const valid = new Set(providers.flatMap((g) => g.models.map((m) => `${g.id}/${m.id}`)));
      const seen = new Set<string>();
      for (const v of recent) {
        if (!v || !valid.has(v) || seen.has(v)) continue;
        seen.add(v);
        const [pid, mid] = splitModel(v);
        const g = providers.find((x) => x.id === pid);
        const m = g?.models.find((x) => x.id === mid);
        const label = g && m ? `${g.label} · ${m.label}` : v;
        out.push({ value: v, label, group: "Recent" });
        if (out.length >= 5) break;
      }
    }
    if (defaultModel) {
      out.push({ value: "", label: `Server default · ${pretty(defaultModel)}` });
    }
    const recentSet = new Set(out.filter((e) => e.group === "Recent").map((e) => e.value));
    providers.forEach((g) =>
      g.models.forEach((m) => {
        const v = `${g.id}/${m.id}`;
        if (recentSet.has(v)) return;
        out.push({ value: v, label: m.label, group: g.label });
      }),
    );
    return out;
  }, [providers, defaultModel, recent]);

  // model-menu filter: keyboard brain navigates the FILTERED list, so
  // highlight indices always match what's on screen
  const [mq, setMq] = useState("");
  const q = mq.trim().toLowerCase();
  const entries: ModelEntry[] = useMemo(
    () =>
      q
        ? allEntries.filter(
            (e2) =>
              e2.label.toLowerCase().includes(q) ||
              e2.value.toLowerCase().includes(q) ||
              (e2.group ?? "").toLowerCase().includes(q),
          )
        : allEntries,
    [q, allEntries],
  );
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
    if (v) {
      const next = pushRecentModel(v);
      setRecent(next);
    }
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
                <img src={a.url} alt="" data-tip="Click to expand" onClick={() => setPreview(a.url)} />
              ) : (
                <i className={`fa-solid ${iconFor(a.mime)} attach-icon`} />
              )}
              <div className="attach-meta">
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
              </div>
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
        {findOpen && (
          <div className="comp-find" onMouseDown={(e) => e.preventDefault()}>
            <input
              ref={findInputRef}
              className="comp-find-input mono"
              placeholder="Find"
              value={findQuery}
              autoFocus
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={onFindKey}
            />
            <span className="comp-find-count mono">
              {findQuery ? `${compMatches.length ? findCur + 1 : 0}/${compMatches.length}` : ""}
            </span>
            <button className="icon-btn" data-tip="Previous (Shift+Enter)" onClick={() => gotoFind(findCur - 1)}>
              <i className="fa-solid fa-chevron-up" />
            </button>
            <button className="icon-btn" data-tip="Next (Enter)" onClick={() => gotoFind(findCur + 1)}>
              <i className="fa-solid fa-chevron-down" />
            </button>
            <button
              className={"icon-btn fe-cs" + (findCase ? " on" : "")}
              data-tip="Match case"
              onClick={() => setFindCase((v) => !v)}
            >
              Aa
            </button>
            <button className="icon-btn" data-tip="Close (Esc)" onClick={closeFind}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
        )}
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
        <div className={`comp-input${hasCode ? " has-code" : ""}${hasFind ? " has-find" : ""}`}>
          {hasOverlay && (
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
                    if (findOpen && e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      closeFind();
                      return;
                    }
                    if (findOpen && findQuery && e.key === "Enter" && !e.shiftKey) {
                      // when find is open, Enter in the textarea navigates, not sends
                      e.preventDefault();
                      e.stopPropagation();
                      gotoFind(findCur + (e.shiftKey ? -1 : 1));
                      return;
                    }
                    if (findOpen && (e.key === "F3" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g"))) {
                      e.preventDefault();
                      gotoFind(findCur + (e.shiftKey ? -1 : 1));
                      return;
                    }
                    const el = e.currentTarget as HTMLTextAreaElement;
                    const isMod = e.ctrlKey || e.metaKey;
                    const k = e.key.toLowerCase();
                    if (isMod && !e.altKey && k === "z" && !e.shiftKey) {
                      e.preventDefault();
                      undoComposer();
                      return;
                    }
                    if (isMod && !e.altKey && (k === "y" || (k === "z" && e.shiftKey))) {
                      e.preventDefault();
                      redoComposer();
                      return;
                    }
                    if (handleComposerKeys(e, el, input, setInput)) return;
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
      {preview &&
        createPortal(
          <div className="img-lightbox" onClick={() => setPreview(null)} role="dialog" aria-label="Image preview">
            <img src={preview} alt="" onClick={() => setPreview(null)} />
          </div>,
          document.body,
        )}
    </div>
  );
}

