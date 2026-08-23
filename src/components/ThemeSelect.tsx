import { useEffect, useRef, useState } from "react";
import { THEMES, type ThemeName } from "../hooks/useSettings";

export default function ThemeSelect({
  value,
  onChange,
  variant = "bar",
}: {
  value: ThemeName;
  onChange: (t: ThemeName) => void;
  variant?: "bar" | "drawer";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // capture-phase pointerdown: clicking anywhere outside closes
    const onDoc = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [open]);

  const current = THEMES.find((t) => t.id === value) ?? THEMES[0];

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className={`theme-select${open ? " open" : ""}`} ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="theme-select-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip="Theme"
      >
        <i className={`fa-solid ${current.icon}`} />
        {variant === "drawer" && <span>{current.name}</span>}
      </button>
      {open && (
        <div className="model-menu theme-menu" role="listbox">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={t.id === value}
              className={`model-opt${t.id === value ? " selected" : ""}`}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
            >
              <i className={`fa-solid ${t.icon}`} />
              <span>{t.name}</span>
              {t.id === value && <i className="fa-solid fa-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
