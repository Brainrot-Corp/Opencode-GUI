import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "../styles/tooltip.css";

type TipState = { text: string; x: number; y: number };

/** Renders the hovered element's data-tip in a themed floating bubble.
    One global layer replaces native `title` popups app-wide. */
export default function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  // position persists after the text clears so the fade-out happens in place
  // instead of the bubble jumping to its static top-left corner mid-transition
  const [pos, setPos] = useState({ x: -9999, y: -9999 });
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  // cursor-mode tips (whole-panel click targets) follow the mouse instead of
  // anchoring to the element rect, which would pin them to the panel's edge
  const cursorMode = useRef(false);
  const PAD = 8;

  // measure + clamp synchronously after each text change, BEFORE paint —
  // an rAF here would measure the previous bubble's width and mis-clamp
  useLayoutEffect(() => {
    if (cursorMode.current) return;
    const t = ref.current;
    const el = anchor.current;
    if (!t || !el) return;
    const r = el.getBoundingClientRect();
    const tb = t.getBoundingClientRect();
    const x = Math.min(
      Math.max(r.left + r.width / 2 - tb.width / 2, PAD),
      Math.max(PAD, window.innerWidth - tb.width - PAD),
    );
    // TikTok's floating webview is a native HWND above the main window —
    // any DOM tooltip overlapping its rect is hidden. Force header tips
    // above and auto-flip if overlap would occur. `data-tip-top` opts in.
    const forceTop = el.hasAttribute("data-tip-top");
    const isTiktokHeader = !!el.closest(".tiktok-head");
    let y: number;
    if (forceTop || isTiktokHeader) {
      y = r.top - 7 - tb.height;
      // if not enough space above, fall back below only if it wouldn't hit webview
      if (y < PAD && r.bottom + 7 + tb.height < window.innerHeight - PAD) {
        // check would-below overlap TikTok webview
        const belowY = r.bottom + 7;
        let overlaps = false;
        try {
          const raw = localStorage.getItem("oc.tiktok");
          if (raw) {
            const p = JSON.parse(raw);
            const g = p.geom;
            if (g && typeof g.x === "number") {
              const INSET = 6, headerH = 36;
              const wx = g.x + INSET, wy = g.y + headerH + INSET, ww = g.w - INSET * 2, wh = g.h - headerH - INSET * 2;
              const tipRect = { left: x, top: belowY, right: x + tb.width, bottom: belowY + tb.height };
              const webRect = { left: wx, top: wy, right: wx + ww, bottom: wy + wh };
              overlaps = !(tipRect.right < webRect.left || tipRect.left > webRect.right || tipRect.bottom < webRect.top || tipRect.top > webRect.bottom);
            }
          }
        } catch {}
        if (!overlaps) y = belowY;
      }
    } else {
      y = r.bottom + 7;
      if (y + tb.height > window.innerHeight - PAD && r.top - 7 - tb.height >= PAD) {
        y = r.top - 7 - tb.height;
      }
    }
    // final clamp
    y = Math.max(PAD, Math.min(y, window.innerHeight - tb.height - PAD));
    setPos({ x, y });
    setTip((p) => (p && (p.x !== x || p.y !== y) ? { ...p, x, y } : p));
  }, [tip]);

  useEffect(() => {
    const placeAtCursor = (cx: number, cy: number) => {
      const t = ref.current;
      if (!t) return;
      const tb = t.getBoundingClientRect();
      // below the cursor by a comfortable gap; flip above near the bottom edge,
      // clamp horizontally so it never leaves the viewport
      let y = cy + 22;
      if (y + tb.height > window.innerHeight - PAD && cy - 10 - tb.height >= PAD) y = cy - 10 - tb.height;
      setPos({
        x: Math.min(Math.max(cx - tb.width / 2, PAD), Math.max(PAD, window.innerWidth - tb.width - PAD)),
        y: Math.min(y, window.innerHeight - tb.height - PAD),
      });
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
      if (!el) {
        setTip(null);
        cursorMode.current = false;
        return;
      }
      anchor.current = el;
      cursorMode.current = el.hasAttribute("data-tip-cursor");
      if (cursorMode.current) {
        placeAtCursor(e.clientX, e.clientY);
        setTip({ text: el.dataset.tip!, x: e.clientX, y: e.clientY });
        return;
      }
      const r = el.getBoundingClientRect();
      // rough first paint; the layout effect below clamps before it's seen
      setPos({ x: r.left, y: r.bottom + 7 });
      setTip({ text: el.dataset.tip!, x: r.left, y: r.bottom + 7 });
    };
    const move = (e: MouseEvent) => {
      if (cursorMode.current) placeAtCursor(e.clientX, e.clientY);
    };
    const out = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-tip]")) {
        setTip(null);
        cursorMode.current = false;
      }
    };
    // actions often change state under the cursor; also hide on any
    // scroll/resize so the bubble can't be left dangling out of bounds
    const down = () => setTip(null);
    const hide = () => setTip(null);
    document.addEventListener("mouseover", over);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseout", out);
    document.addEventListener("mousedown", down);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`tip${tip ? " show" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      role="tooltip"
    >
      {tip?.text}
    </div>
  );
}
