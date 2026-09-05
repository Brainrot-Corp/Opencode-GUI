import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "../styles/contextMenu.css";

export type CtxItem =
  | { label: string; icon?: string; shortcut?: string; disabled?: boolean; danger?: boolean; action?: () => void; checked?: boolean }
  | { separator: true }
  | { header: string };

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ position: "fixed", left: x, top: y, zIndex: 100 });
  const [hl, setHl] = useState(0);

  // position flip/clamp like DropdownPortal — height hugs content, capped to viewport
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // cap to available viewport so short menus hug and long ones scroll
    const vh0 = window.innerHeight;
    el.style.maxHeight = `${Math.max(96, vh0 - y - 14)}px`;
    el.style.height = "auto";
    requestAnimationFrame(() => {
      const b = el.getBoundingClientRect();
      let nx = x;
      let ny = y;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // re-cap after flip: use whichever side has more room
      const roomBelow = vh - y - 8;
      const roomAbove = y - 8;
      if (b.height > roomBelow && roomAbove > roomBelow) {
        el.style.maxHeight = `${Math.max(96, roomAbove)}px`;
      } else {
        el.style.maxHeight = `${Math.max(96, roomBelow)}px`;
      }
      // flip horizontal if overflow right
      if (x + b.width > vw - 8) nx = Math.max(8, x - b.width);
      // flip vertical if overflow bottom
      if (y + b.height > vh - 8) ny = Math.max(8, y - b.height);
      // also ensure not off left/top
      if (nx < 8) nx = 8;
      if (ny < 8) ny = 8;
      setPos({ position: "fixed", left: nx, top: ny, zIndex: 100 });
      // final clamp after flip position — ensure not overflowing viewport
      requestAnimationFrame(() => {
        const bb = el.getBoundingClientRect();
        if (bb.bottom > vh - 8) el.style.maxHeight = `${Math.max(96, vh - ny - 8)}px`;
      });
    });
  }, [x, y, items]);

  // outside click / Escape
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); moveHl(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); moveHl(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); triggerHl(); }
    };
    const moveHl = (dir: number) => {
      // skip separators/headers
      const selectable = items.reduce<number[]>((a, it, i) => {
        if ("separator" in it || "header" in it) return a;
        if ((it as any).disabled) return a;
        return [...a, i];
      }, []);
      if (!selectable.length) return;
      const curIdx = selectable.indexOf(hl);
      const next = selectable[(curIdx + dir + selectable.length) % selectable.length];
      setHl(next);
      // scroll into view
      requestAnimationFrame(() => {
        const el = ref.current?.querySelector(`[data-idx="${next}"]`);
        el?.scrollIntoView({ block: "nearest" });
      });
    };
    const triggerHl = () => {
      const it: any = items[hl];
      if (!it || it.separator || it.header || it.disabled) return;
      if (it.action) { it.action(); onClose(); }
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down, true); document.removeEventListener("keydown", key); };
  }, [onClose, items, hl]);

  // init highlight to first selectable
  useEffect(() => {
    const first = items.findIndex((it: any) => !("separator" in it) && !("header" in it) && !(it as any).disabled);
    setHl(first >= 0 ? first : 0);
  }, [items]);

  return createPortal(
    <div ref={ref} className="ctx-menu" style={pos} role="menu" onContextMenu={(e)=>e.preventDefault()}>
      {items.map((it: any, i) => {
        if (it.separator) return <div key={i} className="ctx-sep" role="separator" />;
        if (it.header) return <div key={i} className="ctx-header">{it.header}</div>;
        const disabled = !!it.disabled;
        const danger = !!it.danger;
        const isHl = i === hl;
        return (
          <button
            key={i}
            data-idx={i}
            role="menuitem"
            aria-disabled={disabled}
            disabled={disabled}
            className={`ctx-item${danger ? " danger" : ""}${isHl ? " hl" : ""}`}
            onMouseEnter={() => !disabled && setHl(i)}
            onClick={() => {
              if (disabled) return;
              if (it.action) it.action();
              onClose();
            }}
          >
            {it.icon && <i className={`fa-solid ${it.icon}`} />}
            <span className="ctx-label">{it.label}</span>
            {it.checked && <i className="fa-solid fa-check" style={{ fontSize: 9 }} />}
            {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
