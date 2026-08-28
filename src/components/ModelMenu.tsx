import { useEffect, useMemo, useRef, useState } from "react";
import DropdownPortal from "./DropdownPortal";

export type ModelEntry = { value: string; label: string; group?: string };

function loadCollapsed(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {}
  return new Set();
}

// model picker dropdown: trigger button + filter input + grouped option
// list. Selection state (open / highlight / query) is owned by the composer
// so its single global keydown router keeps driving navigation; this
// component owns only the outside-click close, search focus, and
// highlight scroll-into-view. Groups are collapsible (persisted via
// localStorage) — filtering temporarily expands all groups.
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
  collapseKey = "oc.modelGroups.collapsed",
  searchPlaceholder = "Filter models…",
  emptyLabel = "No models match",
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
  collapseKey?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(collapseKey));
  const isFiltering = query.trim().length > 0;

  // keep collapsed set in sync if collapseKey changes (e.g. secondary picker)
  useEffect(() => {
    setCollapsed(loadCollapsed(collapseKey));
  }, [collapseKey]);

  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) if (e.group) m.set(e.group, (m.get(e.group) ?? 0) + 1);
    return m;
  }, [entries]);

  function toggleGroup(group: string) {
    const collapsing = !collapsed.has(group);
    // hovering a model sets hi to its index — collapsing its own group would
    // otherwise be immediately undone by the auto-expand-on-hi effect, so
    // clear the highlight when the highlighted entry lives inside the group
    // being collapsed (ponytail: minimal guard, keeps keyboard expand intact)
    if (collapsing && hi >= 0 && hi < entries.length && entries[hi]?.group === group) {
      setHi(() => -1);
    }
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        localStorage.setItem(collapseKey, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }

  // auto-expand the group that contains the highlighted entry — arrowing
  // into a collapsed group reveals it instead of hiding the highlight
  useEffect(() => {
    if (!open || isFiltering) return;
    if (hi < 0 || hi >= entries.length) return;
    const g = entries[hi]?.group;
    if (g && collapsed.has(g)) {
      setCollapsed((prev) => {
        if (!prev.has(g)) return prev;
        const n = new Set(prev);
        n.delete(g);
        try {
          localStorage.setItem(collapseKey, JSON.stringify([...n]));
        } catch {}
        return n;
      });
    }
  }, [hi, entries, collapsed, open, isFiltering, collapseKey]);

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
  }, [hi, open, collapsed]);

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
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
          </div>
          {entries.length === 0 && <div className="model-empty">{emptyLabel}</div>}
          {entries.map((it, i) => {
            const showGroup = !!(it.group && entries[i - 1]?.group !== it.group);
            const group = it.group;
            const isCollapsed = !!group && !isFiltering && collapsed.has(group);
            const count = group ? (groupCounts.get(group) ?? 0) : 0;
            return (
              <div key={`${it.group ?? ""}:${it.value || "def"}:${i}`}>
                {showGroup && group && (
                  <button
                    type="button"
                    className={`model-group-label${isCollapsed ? " collapsed" : ""}`}
                    onClick={() => toggleGroup(group)}
                    aria-expanded={!isCollapsed}
                  >
                    <i className={`fa-solid fa-chevron-${isCollapsed ? "right" : "down"}`} />
                    <span>{group}</span>
                    <span className="model-group-count">{count}</span>
                  </button>
                )}
                {!isCollapsed && (
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
                )}
              </div>
            );
          })}
        </div>
      </DropdownPortal>
    </div>
  );
}
