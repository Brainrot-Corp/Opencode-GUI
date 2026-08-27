import { useEffect, useRef } from "react";
import DropdownPortal from "./DropdownPortal";

export type ModelEntry = { value: string; label: string; group?: string };

// model picker dropdown: trigger button + filter input + grouped option
// list. Selection state (open / highlight / query) is owned by the composer
// so its single global keydown router keeps driving navigation; this
// component owns only the outside-click close, search focus, and
// highlight scroll-into-view.
export default function ModelMenu({
  open,
  setOpen,
  hi,
  setHi,
  entries,
  query,
  setQuery,
  selected,
  label,
  disabled,
  needsModel,
  onPick,
}: {
  open: boolean;
  setOpen: (fn: (o: boolean) => boolean) => void;
  hi: number;
  setHi: (fn: (h: number) => number) => void;
  entries: ModelEntry[];
  query: string;
  setQuery: (q: string) => void;
  selected: string;
  label: string;
  disabled?: boolean;
  needsModel?: boolean;
  onPick: (value: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // capture-phase pointerdown: fires before anything else, so clicking
    // anywhere outside the dropdown (trigger box or portaled menu) closes it
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t))
        setOpen(() => false);
    };
    const onBlur = () => setOpen(() => false);
    document.addEventListener("pointerdown", onDoc, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  // keep the highlighted entry visible while arrowing
  useEffect(() => {
    menuRef.current
      ?.querySelector('[data-hl="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  // focus the filter when the menu opens so typing starts filtering at once
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  function toggleMenu() {
    setOpen((o) => {
      const next = !o;
      if (next) setHi(() => entries.findIndex((e2) => e2.value === selected));
      else setHi(() => -1);
      return next;
    });
  }

  return (
    <div
      className={`model-select${open ? " open" : ""}${needsModel ? " needs-model" : ""}`}
      ref={boxRef}
    >
      <button
        type="button"
        className="model-select-btn"
        onClick={toggleMenu}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <i className={`fa-solid fa-chevron-${open ? "up" : "down"}`} />
      </button>
      <DropdownPortal anchor={boxRef} open={open} align="right" prefer="up">
        <div className="model-menu" role="listbox" ref={menuRef}>
          <div className="model-search-wrap">
            <i className="fa-solid fa-magnifying-glass" />
            <input
              ref={searchRef}
              className="model-search"
              type="text"
              placeholder="Filter models…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>
          {entries.length === 0 && <div className="model-empty">No models match</div>}
          {entries.map((it, i) => {
            const showGroup = it.group && entries[i - 1]?.group !== it.group;
            return (
              <div key={`${it.group ?? ""}:${it.value || "def"}:${i}`}>
                {showGroup && <div className="model-group-label">{it.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === it.value}
                  data-hl={hi === i || undefined}
                  className={`model-opt${selected === it.value ? " selected" : ""}${hi === i ? " hl" : ""}`}
                  onClick={() => onPick(it.value)}
                  onMouseEnter={() => setHi(() => i)}
                >
                  <span>{it.label}</span>
                  {selected === it.value && <i className="fa-solid fa-check" />}
                </button>
              </div>
            );
          })}
        </div>
      </DropdownPortal>
    </div>
  );
}
