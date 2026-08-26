import { useEffect, useRef, useState } from "react";
import DropdownPortal from "./DropdownPortal";

// custom dropdown matching the model picker design language (native select
// popups can't be styled) — trigger + glass menu portaled to document.body
// (DropdownPortal) so it paints above every panel, closes on outside click.
// Opens downward, hugging the trigger's left edge — or right edge inside
// dialogs, where the picker sits at the row's end.
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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
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
      <DropdownPortal anchor={ref} open={open} prefer="down">
        <div className="model-menu picker-drop" role="listbox" ref={menuRef}>
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
      </DropdownPortal>
    </div>
  );
}
