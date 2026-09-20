import { useCallback, useRef, useState } from "react";

// generic edge-resize drag: rAF-coalesced width updates, body cursor lock,
// blur safety. Caller wires sounds (onTick) and persistence (width effect).
export function useDragResize(opts: {
  min: number;
  max: number;
  initial: () => number;
  onTick?: () => void;
}) {
  const { min, max, onTick } = opts;
  const [width, setWidth] = useState(() => Math.min(Math.max(min, opts.initial()), max));
  const [resizing, setResizing] = useState(false);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      let lastTick = 0;
      setResizing(true);
      // body.resizing lets CSS force the custom col-resize cursor over every
      // descendant cursor rule (panels/buttons/editors all declare their own)
      document.body.classList.add("resizing");
      document.body.style.userSelect = "none";
      // rAF-coalesced like the terminal dock drags — raw mousemove far
      // outpaces paint and each event would schedule a full app relayout
      let raf = 0;
      let pending: number | null = null;
      const move = (ev: MouseEvent) => {
        pending = Math.min(Math.max(min, startW + (ev.clientX - startX)), max);
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
        document.body.classList.remove("resizing");
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      // hiding/minimizing mid-drag eats the mouseup — end the drag on blur
      window.addEventListener("blur", up);
    },
    [width, min, max],
  );

  return { width, setWidth, resizing, startResize };
}
