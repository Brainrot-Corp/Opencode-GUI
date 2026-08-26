import { useEffect, useRef, useState } from "react";
import type { ThemeMeta } from "../lib/themes";
import DropdownPortal from "./DropdownPortal";

// theme picker fed the live config-driven list — additions/deletions in
// themes.json show up here without a restart. Menu is portaled via
// DropdownPortal so it paints above every panel and clamps into view.
export default function ThemeSelect({
  themes,
  value,
  onChange,
  variant = "bar",
}: {
  themes: ThemeMeta[];
  value: string;
  onChange: (t: string) => void;
  variant?: "bar" | "drawer";
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // capture-phase pointerdown: clicking anywhere outside closes — both the
    // trigger box and the portaled menu count as inside
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [open]);

  const current =
    themes.find((t) => t.id === value) ??
    themes[0] ?? { id: value, name: value, icon: "fa-palette" };

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className={`theme-select${open ? " open" : ""}`} ref={boxRef} onKeyDown={onKeyDown}>
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
      <DropdownPortal anchor={boxRef} open={open} align="right" prefer="down">
        <div className="model-menu" role="listbox" ref={menuRef}>
          {themes.map((t) => (
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
      </DropdownPortal>
    </div>
  );
}
