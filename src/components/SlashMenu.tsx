import { useEffect, useRef } from "react";
import type { CmdEntry } from "../hooks/useOpencode";

// slash-command suggestion dropdown. Rendering + highlight scroll-into-view
// only — key routing (arrows/Tab/Enter/Esc) lives in the composer's single
// global keydown handler.
export default function SlashMenu({
  entries,
  hi,
  onHover,
  onPick,
}: {
  entries: CmdEntry[];
  hi: number;
  onHover: (i: number) => void;
  // takesArgs commands fill the input, arg-less ones run instantly
  onPick: (c: CmdEntry) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current
      ?.querySelector('[data-hl="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, entries]);

  return (
    <div className="cmd-menu" role="listbox" ref={menuRef}>
      {entries.map((c, i) => (
        <button
          type="button"
          role="option"
          key={c.name}
          aria-selected={i === hi}
          data-hl={i === hi || undefined}
          className={`cmd-opt${i === hi ? " hl" : ""}`}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(c)}
        >
          <span className="mono cmd-opt-name">/{c.name}</span>
          <span className="cmd-opt-desc">{c.description || "—"}</span>
          {c.source !== "built-in" && <span className="cmd-opt-src">{c.source}</span>}
        </button>
      ))}
    </div>
  );
}
