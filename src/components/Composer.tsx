import { useEffect, useRef, useState } from "react";
import type { ProviderGroup } from "../types";
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
}: {
  busy: boolean;
  loadingModels?: boolean;
  providers: ProviderGroup[];
  modelSel: string;
  defaultModel?: string;
  onModelSelect: (value: string) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // no selection and the server default is still unknown → require a pick
  const needsModel = !loadingModels && !modelSel && !defaultModel;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pretty = (sel: string) => {
    const [pid, mid] = sel.split("/");
    const g = providers.find((x) => x.id === pid);
    const m = g?.models.find((x) => x.id === mid);
    return g && m ? `${g.label} · ${m.label}` : sel;
  };

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
    onSend(text);
  };

  return (
    <div className="composer">
      <div className="model-row">
        <span>{currentLabel()}</span>
        <div className={`model-select${open ? " open" : ""}${needsModel ? " needs-model" : ""}`} ref={boxRef}>
          <button
            type="button"
            className="model-select-btn"
            onClick={() => setOpen((o) => !o)}
            disabled={loadingModels}
          >
            <span>{currentLabel()}</span>
            <i className={`fa-solid fa-chevron-${open ? "up" : "down"}`} />
          </button>
          {open && (
            <div className="model-menu">
              {defaultModel && (
                <button
                  type="button"
                  className={`model-opt${!modelSel ? " selected" : ""}`}
                  onClick={() => {
                    onModelSelect("");
                    setOpen(false);
                  }}
                >
                  <span>Server default · {pretty(defaultModel)}</span>
                  {!modelSel && <i className="fa-solid fa-check" />}
                </button>
              )}
              {providers.map((g) => (
                <div key={g.id} className="model-group">
                  <div className="model-group-label">{g.label}</div>
                  {g.models.map((m) => {
                    const v = `${g.id}/${m.id}`;
                    return (
                      <button
                        key={v}
                        type="button"
                        className={`model-opt${modelSel === v ? " selected" : ""}`}
                        onClick={() => {
                          onModelSelect(v);
                          setOpen(false);
                        }}
                      >
                        <span>{m.label}</span>
                        {modelSel === v && <i className="fa-solid fa-check" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
              <div className="composer-row">
                <textarea
                  value={input}
                  disabled={needsModel}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
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
