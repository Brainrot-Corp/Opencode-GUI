import { useEffect, useRef, useState } from "react";
import DropdownPortal from "./DropdownPortal";

type SecurityMode = "full" | "user" | "block";

const MODES: { id: SecurityMode; label: string; icon: string; desc: string }[] = [
  { id: "user", label: "User", icon: "fa-user-shield", desc: "allow once / always prompts" },
  { id: "block", label: "Block", icon: "fa-lock", desc: "auto-deny permission requests" },
  { id: "full", label: "Full", icon: "fa-bolt", desc: "no permission prompts (auto-allow)" },
];

export default function SecurityMenu({
  securityMode,
  onSelect,
}: {
  securityMode?: SecurityMode;
  onSelect: (m: SecurityMode) => void;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);

  const cur = securityMode ?? "user";
  const curMeta = MODES.find((m) => m.id === cur) ?? MODES[0];

  // wheel over the chip cycles permission mode for quick access (accumulates
  // small trackpad deltas; skipped while the dropdown is open so it scrolls)
  const wheelAcc = useRef(0);
  const stepSec = (dir: 1 | -1) => {
    const idx = MODES.findIndex((m) => m.id === cur);
    const next = MODES[(idx < 0 ? 0 : idx + dir + MODES.length) % MODES.length];
    if (next && next.id !== cur) onSelect(next.id);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (open) return;
    e.preventDefault();
    e.stopPropagation();
    wheelAcc.current += e.deltaY;
    if (Math.abs(wheelAcc.current) < 30) return;
    const dir = wheelAcc.current > 0 ? 1 : -1;
    wheelAcc.current = 0;
    stepSec(dir);
  };

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

  useEffect(() => { if (open) setHi(MODES.findIndex((m) => m.id === cur)); }, [open, cur]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) setHi(MODES.findIndex((m) => m.id === cur));
      else setHi(-1);
      return next;
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Tab") {
      e.preventDefault(); e.stopPropagation();
      setHi((h) => {
        const dir = e.shiftKey ? -1 : 1;
        return Math.max(0, Math.min(MODES.length - 1, (h < 0 ? 0 : h) + dir));
      }); return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, MODES.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const c = MODES[Math.max(0, Math.min(hi, MODES.length - 1))]; if (c) { onSelect(c.id); setOpen(false); } }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="agent-menu-wrap" onKeyDown={onKey}>
      <button
        ref={chipRef}
        type="button"
        className={`agent-chip security-chip sec-${cur}`}
        data-tip={
          cur === "full" ? "Full control — no permission prompts (auto-allow) — click to pick, scroll to switch"
          : cur === "block" ? "Block — auto-deny permission requests — click to pick, scroll to switch"
          : "User mode — classic allow once / always prompts — click to pick, scroll to switch"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        onWheel={onWheel}
      >
        <i className={`fa-solid ${curMeta.icon}`} />
        {curMeta.label}
      </button>
      <DropdownPortal anchor={chipRef} open={open} align="left" prefer="down">
        <div className="model-menu agent-menu" role="listbox" ref={menuRef}>
          {MODES.map((m, i) => {
            const isSel = cur === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={isSel}
                data-hi={hi === i || undefined}
                className={`model-opt agent-opt${isSel ? " selected" : ""}${hi === i ? " hl" : ""}`}
                onClick={() => { onSelect(m.id); setOpen(false); }}
                onMouseEnter={() => setHi(i)}
              >
                <span className="agent-opt-name">
                  <i className={`fa-solid ${m.icon}`} style={{ fontSize: 9 }} />
                  {m.label}
                  <span className="agent-opt-mode" style={{ textTransform: "none", marginLeft: 6, opacity: 0.8 }}>{m.desc}</span>
                </span>
                {isSel && <i className="fa-solid fa-check" />}
              </button>
            );
          })}
        </div>
      </DropdownPortal>
    </div>
  );
}
