import { useEffect, useRef, useState } from "react";
import DropdownPortal from "./DropdownPortal";

export default function VariantMenu({
  variants,
  variantSel,
  onSelect,
}: {
  variants: string[];
  variantSel: string;
  onSelect: (v: string) => void;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);

  const cur = variantSel || "";
  const opts = ["", ...variants];

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
    if (open) setHi(opts.indexOf(cur));
  }, [open, cur, variants]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) setHi(opts.indexOf(cur));
      else setHi(-1);
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
        return Math.max(0, Math.min(opts.length - 1, (h < 0 ? 0 : h) + dir));
      });
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, opts.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const cand = opts[Math.max(0, Math.min(hi, opts.length - 1))];
      if (cand !== undefined) { onSelect(cand); setOpen(false); }
    } else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  if (!variants.length && !variantSel) return null;

  return (
    <div className="agent-menu-wrap" onKeyDown={onKey}>
      <button
        ref={chipRef}
        type="button"
        className="agent-chip"
        data-tip={`Thinking effort: ${cur || "default"} — click to pick`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <i className="fa-solid fa-gauge-high" />
        {cur || "default"}
      </button>
      <DropdownPortal anchor={chipRef} open={open} align="left" prefer="down">
        <div className="model-menu agent-menu" role="listbox" ref={menuRef}>
          {opts.map((v, i) => {
            const label = v || "default";
            const isSel = cur === v;
            return (
              <button
                key={v || "__default__"}
                type="button"
                role="option"
                aria-selected={isSel}
                data-hi={hi === i || undefined}
                className={`model-opt agent-opt${isSel ? " selected" : ""}${hi === i ? " hl" : ""}`}
                onClick={() => { onSelect(v); setOpen(false); }}
                onMouseEnter={() => setHi(i)}
              >
                <span className="agent-opt-name">
                  <i className="fa-solid fa-gauge-high" style={{ fontSize: 9 }} />
                  {label}
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
