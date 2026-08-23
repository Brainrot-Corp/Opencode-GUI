import { useEffect, useRef, useState } from "react";
import type { ProviderGroup } from "../types";
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
}: {
  busy: boolean;
  loadingModels?: boolean;
  providers: ProviderGroup[];
  modelSel: string;
  defaultModel?: string;
  onModelSelect: (value: string) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onToggleDiff?: () => void;
  onPickWorkspace?: () => void;
  workspace?: string;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1); // keyboard highlight index
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // no selection and the server default is still unknown → require a pick
  const needsModel = !loadingModels && !modelSel && !defaultModel;

  const pretty = (sel: string) => {
    const [pid, mid] = sel.split("/");
    const g = providers.find((x) => x.id === pid);
    const m = g?.models.find((x) => x.id === mid);
    return g && m ? `${g.label} · ${m.label}` : sel;
  };

  // flat selectable entries (server default first, then provider models)
  const entries: { value: string; label: string; group?: string }[] = [];
  if (defaultModel) {
    entries.push({ value: "", label: `Server default · ${pretty(defaultModel)}` });
  }
  providers.forEach((g) =>
    g.models.forEach((m) =>
      entries.push({ value: `${g.id}/${m.id}`, label: m.label, group: g.label }),
    ),
  );

  useEffect(() => {
    if (!open) return;
    // capture-phase pointerdown: fires before anything else, so clicking
    // anywhere outside the dropdown always closes it
    const onDoc = (e: Event) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    document.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  // keep the highlighted entry visible while arrowing
  useEffect(() => {
    menuRef.current
      ?.querySelector('[data-hl="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  function toggleMenu() {
    setOpen((o) => {
      const next = !o;
      if (next) setHi(entries.findIndex((e2) => e2.value === modelSel));
      else setHi(-1);
      return next;
    });
  }

  const pick = (v: string) => {
    onModelSelect(v);
    setOpen(false);
    setHi(-1);
  };

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setHi(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && hi >= 0 && hi < entries.length) {
      e.preventDefault();
      pick(entries[hi].value);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHi(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHi(entries.length - 1);
    }
  }

  const currentLabel = () => {
    if (loadingModels) return "loading models…";
    if (needsModel) return "choose a model to start";
    if (modelSel) return pretty(modelSel);
    return `${pretty(defaultModel ?? "")} (server default)`;
  };

  const send = () => {
    const text = input.trim();
    if (!text || needsModel) return;
    setInput("");
    playSound("send");
    onSend(text);
  };

  return (
    <div className="composer">
      <div className="model-row">
        <span>{currentLabel()}</span>
        <div
          className={`model-select${open ? " open" : ""}${needsModel ? " needs-model" : ""}`}
          ref={boxRef}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            className="model-select-btn"
            onClick={toggleMenu}
            disabled={loadingModels}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span>{currentLabel()}</span>
            <i className={`fa-solid fa-chevron-${open ? "up" : "down"}`} />
          </button>
          {open && (
            <div className="model-menu" role="listbox" ref={menuRef}>
              {entries.map((it, i) => {
                const showGroup = it.group && entries[i - 1]?.group !== it.group;
                return (
                  <div key={it.value || `def-${i}`}>
                    {showGroup && <div className="model-group-label">{it.group}</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={modelSel === it.value}
                      data-hl={hi === i || undefined}
                      className={`model-opt${modelSel === it.value ? " selected" : ""}${hi === i ? " hl" : ""}`}
                      onClick={() => pick(it.value)}
                      onMouseEnter={() => setHi(i)}
                    >
                      <span>{it.label}</span>
                      {modelSel === it.value && <i className="fa-solid fa-check" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
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
              <div className="composer-row">
                <textarea
                  value={input}
                  disabled={needsModel}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    // typing sounds: distinct for keys, erase, newline
                    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                      if (e.key === "Backspace" || e.key === "Delete") playSound("erase");
                      else if (e.key === "Enter" && e.shiftKey) playSound("newline");
                      else if (e.key.length === 1) playSound("type");
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
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
                    disabled={!input.trim() || needsModel}
                  >
                    Send
                    <i className="fa-solid fa-paper-plane" />
                  </button>
                )}
              </div>
    </div>
  );
}
