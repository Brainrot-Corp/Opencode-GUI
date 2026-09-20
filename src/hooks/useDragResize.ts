import { useCallback, useRef, useState } from "react";

// generic edge-resize drag: rAF-coalesced size updates, body cursor lock,
// blur safety. Caller wires sounds (onTick) and persistence (size effect).
// Optional knobs (all default to the original width/non-inverted behavior):
//  orientation "height" — drags clientY instead of clientX
//  invert — delta subtracted (drag up/left grows the panel)
//  bodyClass — body class during drag (default "resizing"; panels with their
//   own cursor rule pass e.g. "gp-resizing")
//  cursor — inline body cursor override (body.resizing CSS forces col-resize;
//   vertical drags pass "row-resize")
//  clamp — final shaping pass (flooring etc.) applied to every value
export function useDragResize(opts: {
  min: number;
  max: number;
  initial: () => number;
  onTick?: () => void;
  orientation?: "width" | "height";
  invert?: boolean;
  bodyClass?: string;
  cursor?: string;
  clamp?: (v: number) => number;
}) {
  const {
    min, max, onTick,
    orientation = "width",
    invert = false,
    bodyClass = "resizing",
    cursor,
    clamp,
  } = opts;
  const [width, setWidth] = useState(() => {
    const v = Math.min(Math.max(min, opts.initial()), max);
    return clamp ? clamp(v) : v;
  });
  const [resizing, setResizing] = useState(false);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const horizontal = orientation === "width";
      const start = horizontal ? e.clientX : e.clientY;
      const startW = width;
      let lastTick = 0;
      setResizing(true);
      // body class lets CSS force the custom resize cursor over every
      // descendant cursor rule (panels/buttons/editors all declare their own)
      document.body.classList.add(bodyClass);
      document.body.style.userSelect = "none";
      if (cursor) document.body.style.cursor = cursor;
      // rAF-coalesced like the terminal dock drags — raw mousemove far
      // outpaces paint and each event would schedule a full app relayout
      let raf = 0;
      let pending: number | null = null;
      const shape = (v: number) => {
        const c = Math.min(Math.max(min, invert ? startW - (v - start) : startW + (v - start)), max);
        return clamp ? clamp(c) : c;
      };
      const move = (ev: MouseEvent) => {
        pending = shape(horizontal ? ev.clientX : ev.clientY);
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending === null) return;
          setWidth(pending);
          pending = null;
        });
        const now = performance.now();
        if (now - lastTick > 70) {
          lastTick = now;
          onTickRef.current?.();
        }
      };
      const up = () => {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (pending !== null) { setWidth(pending); pending = null; }
        setResizing(false);
        document.body.classList.remove(bodyClass);
        document.body.style.userSelect = "";
        if (cursor) document.body.style.cursor = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      // hiding/minimizing mid-drag eats the mouseup — end the drag on blur
      window.addEventListener("blur", up);
    },
    [width, min, max, orientation, invert, bodyClass, cursor, clamp],
  );

  return { width, setWidth, resizing, startResize };
}
