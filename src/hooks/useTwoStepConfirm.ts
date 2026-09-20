import { useCallback, useEffect, useRef, useState } from "react";

// double-press confirmation — first press arms (caller shows a hint banner),
// second press within the ttl confirms. Timer/armed state owned here;
// caller wires sounds and the actual action.
// Optional second arg { ttlMs }: overrides the expiry — null = stays armed
// until cancel()/press-confirm (e.g. force-push armed across menu reopen).
// Default keeps the old hard 1s expiry. cancel() disarms without confirming.
export function useTwoStepConfirm(windowMs = 1000, opts?: { ttlMs?: number | null }) {
  const ttl = opts && opts.ttlMs !== undefined ? opts.ttlMs : windowMs;
  const [armed, setArmed] = useState(false);
  const armRef = useRef(0);
  const timerRef = useRef(0);
  const press = useCallback(() => {
    const live = ttl === null ? armRef.current !== 0 : Date.now() - armRef.current < ttl;
    if (live) {
      clearTimeout(timerRef.current);
      armRef.current = 0;
      setArmed(false);
      return true;
    }
    armRef.current = Date.now();
    setArmed(true);
    clearTimeout(timerRef.current);
    if (ttl !== null) {
      timerRef.current = window.setTimeout(() => {
        armRef.current = 0;
        setArmed(false);
      }, ttl);
    }
    return false;
  }, [ttl]);
  const cancel = useCallback(() => {
    clearTimeout(timerRef.current);
    armRef.current = 0;
    setArmed(false);
  }, []);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return { armed, press, cancel };
}
