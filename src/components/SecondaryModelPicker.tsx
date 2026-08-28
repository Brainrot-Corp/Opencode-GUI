import { useEffect, useMemo, useState } from "react";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import { splitModel } from "../lib/models";
import type { ProviderGroup } from "../types";
import { getRecentSecondaryModels, pushRecentSecondaryModel } from "../lib/recentModels";

function prettySecondary(sel: string, providers?: ProviderGroup[]) {
  if (!sel) return "Off — no secondary tasks";
  const [pid, mid] = splitModel(sel);
  const g = providers?.find((x) => x.id === pid);
  const m = g?.models.find((x) => x.id === mid);
  return g && m ? `${g.label} · ${m.label}` : sel;
}

export function buildSecondaryEntries(
  providers?: ProviderGroup[],
  recent: string[] = [],
): ModelEntry[] {
  const out: ModelEntry[] = [];
  // recent group on top — mirrors Composer's main picker (separate storage key)
  if (recent.length && providers?.length) {
    const valid = new Set(providers.flatMap((g) => g.models.map((m) => `${g.id}/${m.id}`)));
    const seen = new Set<string>();
    for (const v of recent) {
      if (!v || !valid.has(v) || seen.has(v)) continue;
      seen.add(v);
      const [pid, mid] = splitModel(v);
      const g = providers.find((x) => x.id === pid);
      const m = g?.models.find((x) => x.id === mid);
      const label = g && m ? `${g.label} · ${m.label}` : v;
      out.push({ value: v, label, group: "Recent" });
      if (out.length >= 5) break;
    }
  }
  out.push({ value: "", label: "Off — no secondary tasks" });
  const recentSet = new Set(out.filter((e) => e.group === "Recent").map((e) => e.value));
  for (const g of providers ?? []) {
    for (const m of g.models) {
      const v = `${g.id}/${m.id}`;
      if (recentSet.has(v)) continue;
      out.push({ value: v, label: m.label, group: g.label });
    }
  }
  return out;
}

export function filterEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.value.toLowerCase().includes(q) ||
      (e.group ?? "").toLowerCase().includes(q),
  );
}

// secondary model picker — same ModelMenu chrome as the composer (collapsible groups, filter, keyboard nav)
// so SettingsDrawer and Onboarding share one implementation instead of duplicating entry/filter logic.
// Recent is stored separately (oc.recentSecondaryModels) and shown as collapsible "Recent" group on top,
// mirroring the main picker's UX.
export default function SecondaryModelPicker({
  value,
  onChange,
  providers,
  disabled,
  collapseKey = "oc.secondaryModel.collapsed",
  loadingLabel = "loading models…",
}: {
  value: string;
  onChange: (v: string) => void;
  providers?: ProviderGroup[];
  disabled?: boolean;
  collapseKey?: string;
  loadingLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => getRecentSecondaryModels());

  // keep recent in sync when value changes externally (e.g. reco suggestion)
  useEffect(() => {
    if (!value || !providers?.length) return;
    if (recent[0] === value) return;
    const valid = providers.some((g) => g.models.some((m) => `${g.id}/${m.id}` === value));
    if (!valid) return;
    const next = pushRecentSecondaryModel(value);
    if (next.join("|") !== recent.join("|")) setRecent(next);
  }, [value, providers, recent]);

  const allEntries = useMemo(() => buildSecondaryEntries(providers, recent), [providers, recent]);
  const entries = useMemo(() => filterEntries(allEntries, query), [allEntries, query]);

  const label = !providers?.length ? loadingLabel : prettySecondary(value, providers);

  // typing restarts highlight at top of filtered results; closing clears query
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q) setHi(0);
    else setHi(allEntries.findIndex((e) => e.value === value));
  }, [query, open, allEntries, value]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // keyboard nav mirrors Composer's model-menu handling (Arrow/Home/End/Enter/Esc)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((h) => Math.min(h + 1, entries.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => Math.max(h - 1, 0));
      } else if (e.key === "Home") {
        e.preventDefault();
        setHi(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setHi(entries.length - 1);
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        // Enter/Tab picks highlighted entry — also persist recent
        if (hi >= 0 && hi < entries.length) {
          e.preventDefault();
          const c = entries[Math.max(0, Math.min(hi, entries.length - 1))];
          if (c) {
            if (c.value) {
              const next = pushRecentSecondaryModel(c.value);
              setRecent(next);
            }
            onChange(c.value);
            setOpen(false);
            setHi(-1);
            setQuery("");
          }
        } else if (entries.length === 1) {
          // single filtered result
          e.preventDefault();
          const v = entries[0].value;
          if (v) {
            const next = pushRecentSecondaryModel(v);
            setRecent(next);
          }
          onChange(v);
          setOpen(false);
          setHi(-1);
          setQuery("");
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setHi(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, entries, hi, onChange]);

  function pick(v: string) {
    if (v) {
      const next = pushRecentSecondaryModel(v);
      setRecent(next);
    }
    onChange(v);
    setOpen(false);
    setHi(-1);
    setQuery("");
  }

  return (
    <ModelMenu
      open={open}
      setOpen={setOpen}
      hi={hi}
      setHi={setHi}
      entries={entries}
      query={query}
      setQuery={setQuery}
      selected={value}
      label={label}
      disabled={disabled ?? !providers?.length}
      onPick={pick}
      collapseKey={collapseKey}
    />
  );
}
