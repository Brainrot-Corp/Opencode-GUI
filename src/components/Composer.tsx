import { useState } from "react";
import type { ProviderGroup } from "../types";

export default function Composer({
  busy,
  providers,
  modelSel,
  onModelSelect,
  onSend,
  onAbort,
}: {
  busy: boolean;
  providers: ProviderGroup[];
  modelSel: string;
  onModelSelect: (value: string) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const [input, setInput] = useState("");

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onSend(text);
  };

  return (
    <div className="composer">
      <div className="model-row">
        <span>{modelSel || "server default model"}</span>
        <select value={modelSel} onChange={(e) => onModelSelect(e.target.value)}>
          <option value="">Default model</option>
          {providers.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {g.models.map((m) => (
                <option key={m.id} value={`${g.id}/${m.id}`}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
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
            Stop
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
