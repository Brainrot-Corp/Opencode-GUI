import { useState } from "react";
import Dialog from "./Dialog";
import type { CmdEntry } from "../hooks/useOpencode";

// /help — every registered command, grouped by source
export function HelpDialog({
  commands,
  onClose,
}: {
  commands: CmdEntry[];
  onClose: () => void;
}) {
  const groups = new Map<string, CmdEntry[]>();
  for (const c of commands) {
    const g =
      c.source === "built-in" ? "built-in" : c.source === "skill" ? "skill" : c.source === "command" ? "command" : c.source;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  }
  return (
    <Dialog title="Commands" onClose={onClose}>
      {[...groups.entries()].map(([g, list]) => (
        <div key={g} className="cmd-group">
          <div className="cmd-group-label">{g}</div>
          {list.map((c) => (
            <div key={c.name} className="cmd-row">
              <span className="mono cmd-name">/{c.name}</span>
              <span className="cmd-desc">{c.description || "—"}</span>
            </div>
          ))}
        </div>
      ))}
    </Dialog>
  );
}

// /share — the session URL with a copy button
export function ShareDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title="Session shared" onClose={onClose}>
      <div className="cmd-share">
        <span className="mono cmd-url">{url}</span>
        <button
          className="send-btn"
          onClick={() => {
            navigator.clipboard.writeText(url).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
        >
          <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="cmd-note">Anyone with the link can view this conversation.</p>
    </Dialog>
  );
}
