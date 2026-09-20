import { useCallback, useEffect, useRef, useState } from "react";

// double-press confirmation — first press arms (caller shows a hint banner),
// second press within `windowMs` confirms. Timer/armed state owned here;
// caller wires sounds and the actual action.
export function useTwoStepConfirm(windowMs = 1000) {
  const [armed, setArmed] = useState(false);
  const armRef = useRef(0);
  const timerRef = useRef(0);
  const press = useCallback(() => {
    if (Date.now() - armRef.current < windowMs) {
      clearTimeout(timerRef.current);
      armRef.current = 0;
      setArmed(false);
      return true;
    }
    armRef.current = Date.now();
    setArmed(true);
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      armRef.current = 0;
      setArmed(false);
    }, windowMs);
    return false;
  }, [windowMs]);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return { armed, press };
}
