import { useEffect, useMemo, useState } from "react";
import ModelMenu, { type ModelEntry } from "./ModelMenu";
import type { TerminalProfile } from "../hooks/useTerminalProfiles";
import type { CustomShell } from "../hooks/useSettings";

function buildShellEntries(profiles: TerminalProfile[], customs: CustomShell[]): ModelEntry[] {
  const out: ModelEntry[] = [{ value: "", label: "System default (PowerShell)" }];
  const groups: Record<string, TerminalProfile[]> = { probe: [], wsl: [], wt: [] };
  for (const p of profiles) {
    if (p.source === "wsl") groups.wsl.push(p);
    else if (p.source === "wt") groups.wt.push(p);
    else groups.probe.push(p);
  }
  if (groups.probe.length) {
    for (const p of groups.probe) {
      out.push({
        value: p.id,
        label: `${p.name} — ${p.path}${p.args.length ? " " + p.args.join(" ") : ""}`,
        group: "Installed shells",
      });
    }
  }
  if (groups.wsl.length) {
    for (const p of groups.wsl) {
      out.push({
        value: p.id,
        label: `${p.name} — ${p.path}${p.args.length ? " " + p.args.join(" ") : ""}`,
        group: "WSL distros",
      });
    }
  }
  if (groups.wt.length) {
    for (const p of groups.wt) {
      out.push({
        value: p.id,
        label: `${p.name} — ${p.path}${p.args.length ? " " + p.args.join(" ") : ""}`,
        group: "Windows Terminal",
      });
    }
  }
  if (customs.length) {
    for (const c of customs) {
      out.push({
        value: c.id,
        label: `Custom: ${c.name} — ${c.path}${c.args ? " " + c.args : ""}`,
        group: "Custom",
      });
    }
  }
  return out;
}

function filterEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.value.toLowerCase().includes(q) ||
      (e.group ?? "").toLowerCase().includes(q),
  );
}

// stylized shell picker — same glass ModelMenu as the model pickers (search bar, grouped, portaled)
// replaces the native <select> that can't be styled
export default function TerminalShellPicker({
  value,
  onChange,
  profiles,
  customShells,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  profiles: TerminalProfile[];
  customShells: CustomShell[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [query, setQuery] = useState("");

  const allEntries = useMemo(() => buildShellEntries(profiles, customShells ?? []), [profiles, customShells]);
  const entries = useMemo(() => filterEntries(allEntries, query), [allEntries, query]);

  const label = useMemo(() => {
    if (!value) return "System default (PowerShell)";
    const e = allEntries.find((x) => x.value === value);
    return e ? e.label : value;
  }, [value, allEntries]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q) setHi(0);
    else setHi(allEntries.findIndex((e) => e.value === value));
  }, [query, open, allEntries, value]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

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
        if (hi >= 0 && hi < entries.length) {
          e.preventDefault();
          const c = entries[Math.max(0, Math.min(hi, entries.length - 1))];
          if (c) {
            onChange(c.value);
            setOpen(false);
            setHi(-1);
            setQuery("");
          }
        } else if (entries.length === 1) {
          e.preventDefault();
          onChange(entries[0].value);
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
      selected={value ?? ""}
      label={label}
      disabled={disabled}
      onPick={pick}
      collapseKey="oc.terminalShell.collapsed"
      searchPlaceholder="Filter shells…"
      emptyLabel="No shells match"
    />
  );
}
