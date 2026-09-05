import { useEffect, useRef, useState } from "react";
import DropdownPortal from "./DropdownPortal";

export default function AgentMenu({
  agents,
  agentSel,
  disabled,
  onSelect,
  onToggleDisabled,
  onRefresh,
}: {
  agents: { name: string; mode: string }[];
  agentSel?: string;
  disabled: Set<string>;
  onSelect: (name: string) => void;
  onToggleDisabled: (name: string) => void;
  onRefresh?: () => void;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);

  const cur = agentSel || agents[0]?.name || "build";
  const enabledCount = agents.filter((a) => !disabled.has(a.name)).length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (!chipRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    document.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  useEffect(() => {
    menuRef.current?.querySelector('[data-hi="true"]')?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  useEffect(() => {
    if (open) setHi(agents.findIndex((a) => a.name === cur));
  }, [open, cur, agents]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        onRefresh?.();
        setHi(agents.findIndex((a) => a.name === cur));
      } else setHi(-1);
      return next;
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      setHi((h) => {
        const dir = e.shiftKey ? -1 : 1;
        return Math.max(0, Math.min(agents.length - 1, (h < 0 ? 0 : h) + dir));
      });
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, agents.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cand = agents[Math.max(0, Math.min(hi, agents.length - 1))];
      if (cand) { onSelect(cand.name); setOpen(false); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Delete" || e.key === "d") {
      // alternative to right-click for keyboard users
      if (hi >= 0 && hi < agents.length) {
        e.preventDefault();
        onToggleDisabled(agents[hi].name);
      }
    }
  };

  return (
    <div className="agent-menu-wrap" onKeyDown={onKey}>
      <button
        ref={chipRef}
        type="button"
        className="agent-chip"
        data-tip={
          agents.length
            ? `Agent — ${cur} — click to pick, Tab to cycle (${enabledCount}/${agents.length} enabled) · right-click a row to disable from Tab`
            : "No agents"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <i className="fa-solid fa-robot" />
        {cur}
      </button>
      <DropdownPortal anchor={chipRef} open={open} align="left" prefer="down">
        <div className="model-menu agent-menu" role="listbox" ref={menuRef}>
          {agents.length === 0 && <div className="model-empty">No agents</div>}
          {agents.map((a, i) => {
            const isSel = a.name === cur;
            const isDisabled = disabled.has(a.name);
            return (
              <button
                key={a.name}
                type="button"
                role="option"
                aria-selected={isSel}
                data-hi={hi === i || undefined}
                className={`model-opt agent-opt${isSel ? " selected" : ""}${hi === i ? " hl" : ""}${isDisabled ? " disabled" : ""}`}
                data-tip={isDisabled ? "Right-click to enable for Tab cycle" : "Right-click to disable from Tab cycle"}
                onClick={() => { onSelect(a.name); setOpen(false); }}
                onContextMenu={(e) => { e.preventDefault(); onToggleDisabled(a.name); }}
                onMouseEnter={() => setHi(i)}
              >
                <span className="agent-opt-name">
                  <i className="fa-solid fa-robot" style={{ fontSize: 9, opacity: isDisabled ? 0.45 : 1 }} />
                  {a.name}
                </span>
                <span className="agent-opt-mode">{a.mode}</span>
                {isDisabled && <span className="agent-disabled-badge">off Tab</span>}
                {isSel && <i className="fa-solid fa-check" />}
              </button>
            );
          })}
          {enabledCount === 0 && agents.length > 0 && (
            <div className="model-empty" style={{ borderTop: "1px solid var(--line)", marginTop: 4 }}>
              All disabled — Tab does nothing · right-click to re-enable
            </div>
          )}
        </div>
      </DropdownPortal>
    </div>
  );
}
