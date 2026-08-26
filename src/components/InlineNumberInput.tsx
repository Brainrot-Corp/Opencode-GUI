import { useEffect, useRef, useState } from "react";

export default function InlineNumberInput({
  value,
  min,
  max,
  step,
  suffix,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: "%" | "×";
  ariaLabel: string;
  onChange: (v: number) => void;
}) {
  const isPercent = suffix === "%";
  const format = (v: number) => (isPercent ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}×`);
  const [draft, setDraft] = useState(() => format(value));
  const ref = useRef<HTMLInputElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(format(value));
  }, [value]);

  const commit = () => {
    let raw = draft.trim().replace("×", "").replace("%", "").replace(",", ".").trim();
    if (raw === "") {
      setDraft(format(value));
      return;
    }
    let n = Number.parseFloat(raw);
    if (Number.isNaN(n)) {
      setDraft(format(value));
      return;
    }
    if (isPercent) n = n / 100;
    let clamped = Math.min(max, Math.max(min, n));
    // snap to nearest step
    const snapped = Math.round((clamped - min) / step) * step + min;
    const fixed = Number.parseFloat(snapped.toFixed(4));
    if (Math.abs(fixed - value) > 1e-9) onChange(fixed);
    setDraft(format(fixed));
  };

  return (
    <input
      ref={ref}
      className={`alpha-num alpha-input${!isPercent ? " speed" : ""}`}
      aria-label={ariaLabel}
      value={draft}
      inputMode={isPercent ? "numeric" : "decimal"}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focused.current = true;
        // select numeric part for quick replace
        requestAnimationFrame(() => ref.current?.select());
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(format(value));
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const dir = e.key === "ArrowUp" ? 1 : -1;
          // derive current numeric display value
          let curRaw = draft.trim().replace("×", "").replace("%", "").replace(",", ".").trim();
          let cur = Number.parseFloat(curRaw);
          if (Number.isNaN(cur)) cur = isPercent ? value * 100 : value;
          const dStep = isPercent ? step * 100 : step;
          const dMin = isPercent ? min * 100 : min;
          const dMax = isPercent ? max * 100 : max;
          let next = cur + dir * dStep;
          next = Math.min(dMax, Math.max(dMin, next));
          const v = isPercent ? next / 100 : next;
          const snapped = Math.round((v - min) / step) * step + min;
          const fixed = Number.parseFloat(snapped.toFixed(4));
          onChange(fixed);
          setDraft(format(fixed));
        }
      }}
    />
  );
}
