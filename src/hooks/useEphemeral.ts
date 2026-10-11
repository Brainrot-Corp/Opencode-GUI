import { useCallback, useEffect, useRef, useState } from "react";

// Drop-in useState replacement for transient messages (e.g. error banners):
// resets to `initial` 10s after each set, timer restarts on every set so a
// repeated message stays visible 10s from its last occurrence.
export function useEphemeral<T>(initial: T, ms = 10000): [T, (v: T) => void] {
  const [val, setVal] = useState(initial);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  const set = useCallback(
    (v: T) => {
      setVal(v);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setVal(initial);
      }, ms);
    },
    [initial, ms],
  );
  return [val, set];
}
