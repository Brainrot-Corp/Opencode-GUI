import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// renders a dropdown at document.body with fixed coordinates computed from
// its trigger — escapes every ancestor stacking context (the glass panels'
// backdrop-filter) and overflow clip, so the menu always paints on top.
// Flips vertically when the preferred side lacks viewport room and clamps
// horizontally once measured.
export default function DropdownPortal({
  anchor,
  open,
  align,
  prefer,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  // which trigger edge the menu hugs; undefined = auto (right inside .dlg-body)
  align?: "left" | "right";
  // preferred opening direction
  prefer: "up" | "down";
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const a = anchor.current;
    if (!a) {
      setStyle(null);
      return;
    }

    const place = () => {
      const r = a.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        setStyle(null);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let dir = prefer;
      const room = prefer === "down" ? vh - r.bottom : r.top;
      const other = prefer === "down" ? r.top : vh - r.bottom;
      if (room < 316 && other > room) dir = prefer === "down" ? "up" : "down";
      const effAlign =
        align ?? (a.closest(".dlg-body") ? "right" : "left");
      const s: CSSProperties = { position: "fixed", zIndex: 100 };
      if (dir === "down") s.top = r.bottom + 6;
      else s.bottom = vh - r.top + 6;
      if (effAlign === "right") {
        s.right = Math.max(8, vw - r.right);
        s.left = "auto";
      } else {
        s.left = Math.min(r.left, Math.max(8, vw - 296));
        s.right = "auto";
      }
      setStyle(s);
      // clamp into view after the menu has measured
      requestAnimationFrame(() => {
        const w = wrapRef.current;
        if (!w) return;
        w.style.transform = "";
        const b = w.getBoundingClientRect();
        let dx = 0;
        let dy = 0;
        if (b.right > vw - 8) dx = vw - 8 - b.right;
        if (b.left + dx < 8) dx = 8 - b.left;
        if (b.bottom > vh - 8) dy = vh - 8 - b.bottom;
        if (b.top + dy < 8) dy = 8 - b.top;
        if (dx || dy) w.style.transform = `translate(${dx}px, ${dy}px)`;
      });
    };

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, prefer, anchor]);

  if (!open || !style) return null;
  return createPortal(
    <div ref={wrapRef} style={style}>
      {children}
    </div>,
    document.body,
  );
}
