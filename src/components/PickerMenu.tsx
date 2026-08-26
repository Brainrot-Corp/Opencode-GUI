import { useEffect, useRef, useState } from "react";

// custom dropdown matching the model picker design language (native select
// popups can't be styled) — trigger + glass menu, closes on outside click
export default function PickerMenu({
  value,
  onPick,
  entries,
  label,
  disabled,
  empty,
}: {
  value: string;
  onPick: (v: string) => void;
  entries: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [open]);

  return (
    <div className={`picker-menu${open ? " open" : ""}`} ref={ref}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <i className={`fa-solid fa-chevron-${open ? "up" : "down"}`} />
      </button>
      {open && (
        <div className="model-menu picker-drop" role="listbox">
          {entries.length === 0 && empty ? (
            <div className="model-empty">{empty}</div>
          ) : (
            entries.map((it) => (
            <button
              key={it.value}
              type="button"
              role="option"
              aria-selected={it.value === value}
              className={`model-opt${it.value === value ? " selected" : ""}`}
              onClick={() => {
                onPick(it.value);
                setOpen(false);
              }}
            >
              <span>{it.label}</span>
              {it.value === value && <i className="fa-solid fa-check" />}
            </button>
          ))
          )}
        </div>
      )}
    </div>
  );
}
