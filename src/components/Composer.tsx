import { useState } from "react";
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

  const pretty = (sel: string) => {
    const [pid, mid] = sel.split("/");
    const g = providers.find((x) => x.id === pid);
    const m = g?.models.find((x) => x.id === mid);
    return g && m ? `${g.label} · ${m.label}` : sel;
  };

  const currentLabel = () => {
    if (loadingModels) return "loading models…";
    if (modelSel) return pretty(modelSel);
    return defaultModel ? `${pretty(defaultModel)} (server default)` : "server default model";
  };

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onSend(text);
  };

  return (
    <div className="composer">
      <div className="model-row">
        <span>{currentLabel()}</span>
        <select value={modelSel} onChange={(e) => onModelSelect(e.target.value)} disabled={loadingModels}>
          {loadingModels ? (
            <option>Loading models…</option>
          ) : (
            <>
              <option value="">
                {defaultModel ? `Server default · ${pretty(defaultModel)}` : "Default model"}
              </option>
              {providers.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.models.map((m) => (
                    <option key={m.id} value={`${g.id}/${m.id}`}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </>
          )}
        </select>
      </div>
      <div className="composer-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            busy ? "Waiting for reply…" : "Ask anything (Enter to send, Shift+Enter for newline)"
          }
        />
        {busy ? (
          <button className="stop-btn" onClick={onAbort}>
            <i className="fa-solid fa-stop" />
            Stop
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!input.trim()}>
            Send
            <i className="fa-solid fa-paper-plane" />
          </button>
        )}
      </div>
    </div>
  );
}
