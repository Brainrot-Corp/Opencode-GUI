// plugin host — loads runtime plugins from ~/.config/.opencode-gui/plugins/.
// A plugin is a folder holding plugin.json + main.js (+ styles.css); main.js
// is plain browser ESM whose default export activate(api) returns an
// extension object wiring voice intents, spoken read-back/execution and a
// settings section. See default_plugins/tuya-lights-control for the full
// example. Plugins are trusted local code — they run with app privileges.
import { createElement, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { stripComments } from "./themes";
import { setPluginLexicon } from "./voiceLexicon";
import { playSound as hostPlaySound } from "./sounds";
import { matchesEvent as hostMatchesEvent, normalizeBinding as hostNormalizeBinding } from "./hotkeys";

export type PluginApi = {
  id: string;
  invoke: typeof invoke;
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useRef: typeof useRef;
  // the live oc.settings blob (persisted synchronously on every change)
  settings: () => Record<string, unknown>;
  playSound: (kind: string) => void;
  // hotkey helpers — same as core (so plugins respect user rebinds)
  matchesEvent: typeof hostMatchesEvent;
  normalizeBinding: typeof hostNormalizeBinding;
};

export type PluginExt = {
  id: string;
  name: string;
  // voice: intent parsing slotted into the spoken-command chain (after git,
  // before the app-launcher catch-all), plus vocabulary merges
  parse?: (t: string) => unknown | null;
  describe?: (act: unknown) => string;
  exec?: (act: unknown) => Promise<string | void> | string | void;
  triggers?: string[];
  vocab?: string[];
  // phrasing rewrites applied after the built-in lexicon rules
  lexicon?: [RegExp, string][];
  // React component rendered as a Settings drawer section
  Settings?: (props: {
    open: boolean;
    settings: Record<string, any>;
    updatePlugin: (patch: Record<string, unknown>) => void;
  }) => React.ReactElement | null;
  // React component rendered in the sidebar before GitPanel (Vencord-style player)
  Sidebar?: (props: {
    settings: Record<string, any>;
    updatePlugin: (patch: Record<string, unknown>) => void;
  }) => React.ReactElement | null;
  // React component rendered as a titlebar icon (before Settings gear)
  Titlebar?: (props: {
    settings: Record<string, any>;
    updatePlugin: (patch: Record<string, unknown>) => void;
  }) => React.ReactElement | null;
  // React component rendered as a floating overlay (portal sibling to FileEditorHost)
  Overlay?: (props: {
    settings: Record<string, any>;
    updatePlugin: (patch: Record<string, unknown>) => void;
  }) => React.ReactElement | null;
  // documentation rows appended to the Info dialog's tabs, grouped under the
  // plugin name — same [label, description] shape the built-in groups use
  info?: {
    voice?: [string, string][];
    keys?: [string, string][];
  };
  // slash commands contributed by the plugin — surfaced in the composer's
  // autocomplete and dispatched without hitting the server
  slash?: {
    name: string;
    description: string;
    takesArgs?: boolean;
    handle: (args: string) => Promise<string | void> | string | void;
  }[];
  // app-wide hotkeys contributed by the plugin — appear as rebindable pills
  // in the keybinds menu (same as core hotkeys). Handled via onHotkey or
  // per-entry handle, dispatched centrally through matchesEvent.
  hotkeys?: {
    id: string;
    default: string | null;
    label: string;
    description?: string;
    handle?: () => void | Promise<void>;
  }[];
  onHotkey?: (id: string) => void | Promise<void>;
};

export type LoadedPlugin = {
  id: string;
  name: string;
  dir: string;
  version?: string;
  description?: string;
  ext: PluginExt | null;
  error: string;
  disabled: boolean;
};

// pure manifest reader — node tests exercise this directly
export function parseManifest(
  dir: string,
  raw: string,
): { id: string; name: string; version?: string; description?: string } | null {
  try {
    const m = JSON.parse(stripComments(raw));
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    return {
      id: typeof m.id === "string" && m.id ? m.id : dir,
      name: typeof m.name === "string" && m.name ? m.name : dir,
      version: typeof (m as Record<string, unknown>).version === "string" ? ((m as Record<string, unknown>).version as string) : undefined,
      description: typeof (m as Record<string, unknown>).description === "string" ? ((m as Record<string, unknown>).description as string) : undefined,
    };
  } catch {
    return null;
  }
}

// semver-ish compare: "1.2.3" vs "1.10.0" → -1/0/1. Non-numeric parts treated as 0.
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

export function isNewer(installed: string | undefined, catalog: string | undefined): boolean {
  if (!catalog) return false;
  if (!installed) return true;
  return compareVersion(installed, catalog) < 0;
}

// disabled persistence — localStorage `oc.plugins.disabled` (string[] of ids)
const DISABLED_KEY = "oc.plugins.disabled";

export const AUTO_UPDATE_KEY = "oc.plugins.autoUpdate";

export function getAutoUpdateEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoUpdateEnabled(v: boolean): void {
  try {
    localStorage.setItem(AUTO_UPDATE_KEY, v ? "1" : "0");
    window.dispatchEvent(new CustomEvent("oc:plugins-autoupdate", { detail: v }));
  } catch {}
}

export function getDisabledIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x: unknown) => typeof x === "string" && x));
  } catch {
    return new Set();
  }
}

export function isPluginDisabled(id: string): boolean {
  return getDisabledIds().has(id);
}

export function setPluginDisabled(id: string, disabled: boolean): void {
  const set = getDisabledIds();
  if (disabled) set.add(id);
  else set.delete(id);
  localStorage.setItem(DISABLED_KEY, JSON.stringify([...set]));
}

export function removeDisabledId(id: string): void {
  const set = getDisabledIds();
  if (set.delete(id)) localStorage.setItem(DISABLED_KEY, JSON.stringify([...set]));
}

// slash registry — aggregated from loaded plugins for handleSlash/buildCmdList
let slashStore: { name: string; description: string; takesArgs?: boolean; handle: (args: string) => Promise<string | void> | string | void }[] = [];
export function getPluginSlash() { return slashStore; }
export function setSlashFrom(plugins: LoadedPlugin[]) {
  slashStore = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.slash ?? []));
  try { window.dispatchEvent(new CustomEvent("oc:plugin-slash", { detail: slashStore.map((s) => s.name) })); } catch {}
}
export function syncPluginVocabAndSlash(plugins: LoadedPlugin[]) {
  setPluginLexicon(plugins.flatMap((p) => (p.disabled ? [] : p.ext?.lexicon ?? [])));
  setSlashFrom(plugins);
}

 // assets of the last load — active resources keyed by dir so a single
// plugin can be unloaded without touching the others (disable/delete).
// Each entry may hold a blob URL (main.js) and/or an injected style.
const active = new Map<string, { url?: string; style?: HTMLStyleElement }>();
// cache of last scan content for incremental reload (dir -> {manifest,main,css})
const lastScan = new Map<string, { manifest: string; main: string; css: string }>();

function revokeActive(dir: string, id?: string) {
  const seen = new Set<object>();
  for (const key of [dir, id].filter(Boolean) as string[]) {
    const a = active.get(key);
    if (!a) continue;
    if (!seen.has(a)) {
      seen.add(a);
      if (a.url) {
        try { URL.revokeObjectURL(a.url); } catch {}
      }
      a.style?.remove();
    }
    active.delete(key);
  }
  // style is also indexed by id (dataset.plugin) — remove that too if dir!=id
  if (id && id !== dir) {
    const s = document.querySelector(`style[data-plugin="${CSS.escape(id)}"]`) as HTMLStyleElement | null;
    if (s) s.remove();
  }
}

async function loadOne(d: { dir: string; manifest: string; main: string; css: string }, disabledIds: Set<string>): Promise<LoadedPlugin> {
  const man = parseManifest(d.dir, d.manifest);
  if (!man) throw new Error("bad manifest");
  const disabled = disabledIds.has(man.id) || disabledIds.has(d.dir);
  if (disabled) {
    return { id: man.id, name: man.name, dir: d.dir, version: man.version, description: man.description, ext: null, error: "", disabled: true };
  }
  if (!d.main.trim()) {
    return { id: man.id, name: man.name, dir: d.dir, version: man.version, description: man.description, ext: null, error: "missing main.js", disabled: false };
  }
  // replace any previous resources for this dir/id before re-importing
  revokeActive(d.dir, man.id);
  const url = URL.createObjectURL(new Blob([d.main], { type: "text/javascript" }));
  let mod: any;
  let loaded = false;
  try {
    mod = await import(/* @vite-ignore */ url);
    loaded = true;
  } finally {
    if (!loaded) URL.revokeObjectURL(url);
  }
  const entry: { url?: string; style?: HTMLStyleElement } = { url };
  active.set(d.dir, entry);
  // also keep an alias keyed by id for quick disable lookup when dir != id (same object)
  if (man.id !== d.dir) active.set(man.id, entry);
  const api: PluginApi = {
    id: man.id,
    invoke,
    h: createElement,
    useState,
    useEffect,
    useRef,
    settings: () => {
      try {
        return JSON.parse(localStorage.getItem("oc.settings") || "{}");
      } catch {
        return {};
      }
    },
    playSound: (kind: string) => {
      try { (hostPlaySound as unknown as (k: string) => void)(kind as never); } catch {}
    },
    matchesEvent: hostMatchesEvent,
    normalizeBinding: hostNormalizeBinding,
  };
  const raw = typeof mod.default === "function" ? await mod.default(api) : null;
  if (!raw) {
    return { id: man.id, name: man.name, dir: d.dir, version: man.version, description: man.description, ext: null, error: "", disabled: false };
  }
  if (typeof d.css === "string" && d.css.trim()) {
    const style = document.createElement("style");
    style.dataset.plugin = man.id;
    style.textContent = d.css;
    document.head.appendChild(style);
    const cur = active.get(d.dir);
    if (cur) cur.style = style;
  }
  return { id: man.id, name: man.name, dir: d.dir, version: man.version, description: man.description, ext: { ...raw, id: man.id, name: man.name }, error: "", disabled: false };
}

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  // full reload — used at boot. Clears everything and rebuilds from scan.
  {
    const seen = new Set<object>();
    for (const [, a] of active) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (a.url) {
        try { URL.revokeObjectURL(a.url); } catch {}
      }
      a.style?.remove();
    }
  }
  active.clear();
  lastScan.clear();

  const dirs = await invoke<
    { dir: string; manifest: string; main: string; css: string }[]
  >("plugins_scan").catch(() => []);

  const disabledIds = getDisabledIds();
  const out: LoadedPlugin[] = [];
  for (const d of dirs) {
    try {
      const p = await loadOne(d, disabledIds);
      out.push(p);
    } catch (e) {
      out.push({ id: d.dir, name: d.dir, dir: d.dir, ext: null, error: e instanceof Error ? e.message : String(e), disabled: false });
    }
    lastScan.set(d.dir, { manifest: d.manifest, main: d.main, css: d.css });
  }
  setPluginLexicon(out.flatMap((p) => (p.disabled ? [] : p.ext?.lexicon ?? [])));
  setSlashFrom(out);
  return out;
}

// Incremental helpers — disable/enable a single plugin without touching others.

export function unloadPluginResources(idOrDir: string): void {
  // find the entry for idOrDir and also any alias sharing the same URL object
  const target = active.get(idOrDir);
  if (target) {
    if (target.url) {
      try { URL.revokeObjectURL(target.url); } catch {}
    }
    target.style?.remove();
    // delete all keys pointing to the same object (dir + id alias)
    for (const [k, v] of [...active.entries()]) {
      if (v === target) active.delete(k);
    }
  } else {
    // fallback: delete any entry keyed exactly, and also style by id
    const a = active.get(idOrDir);
    if (a) {
      if (a.url) try { URL.revokeObjectURL(a.url); } catch {}
      a.style?.remove();
      active.delete(idOrDir);
    }
  }
  const s = document.querySelector(`style[data-plugin="${CSS.escape(idOrDir)}"]`) as HTMLStyleElement | null;
  if (s) s.remove();
  lastScan.delete(idOrDir);
  // if the key was an id (not dir), also delete the dir entry whose manifest id matches
  for (const dir of [...lastScan.keys()]) {
    const cached = lastScan.get(dir);
    if (!cached) continue;
    const man = parseManifest(dir, cached.manifest);
    if (man?.id === idOrDir) {
      lastScan.delete(dir);
      break;
    }
  }
}

export async function enablePlugin(idOrDir: string): Promise<LoadedPlugin | null> {
  const dirs = await invoke<
    { dir: string; manifest: string; main: string; css: string }[]
  >("plugins_scan").catch(() => []);
  const entry = dirs.find((d) => {
    const man = parseManifest(d.dir, d.manifest);
    return d.dir === idOrDir || man?.id === idOrDir;
  });
  if (!entry) return null;
  const disabledIds = getDisabledIds();
  // ensure not marked disabled
  if (disabledIds.has(idOrDir)) return null;
  // also need to check manifest id
  const man = parseManifest(entry.dir, entry.manifest);
  if (man && disabledIds.has(man.id)) return null;
  const p = await loadOne(entry, disabledIds);
  lastScan.set(entry.dir, { manifest: entry.manifest, main: entry.main, css: entry.css });
  // refresh lexicon incrementally — caller should recompute from plugins state,
  // but we also update globally for any direct callers
  return p;
}

export async function syncPluginsIncremental(prev: LoadedPlugin[]): Promise<LoadedPlugin[]> {
  const dirs = await invoke<
    { dir: string; manifest: string; main: string; css: string }[]
  >("plugins_scan").catch(() => []);
  const disabledIds = getDisabledIds();
  const byDir = new Map(prev.map((p) => [p.dir, p] as const));
  const next: LoadedPlugin[] = [];
  const seen = new Set<string>();

  for (const d of dirs) {
    seen.add(d.dir);
    const man = parseManifest(d.dir, d.manifest);
    const id = man?.id ?? d.dir;
    const disabled = man ? disabledIds.has(id) || disabledIds.has(d.dir) : false;
    const prevEntry = byDir.get(d.dir);
    const cached = lastScan.get(d.dir);
    const contentChanged = !cached || cached.manifest !== d.manifest || cached.main !== d.main || cached.css !== d.css;
    const disabledChanged = !!prevEntry && prevEntry.disabled !== disabled;
    const needsReload = !prevEntry || contentChanged || disabledChanged;

    if (!needsReload && prevEntry && !prevEntry.disabled && prevEntry.ext) {
      next.push(prevEntry);
      // keep cached scan up to date (already)
      continue;
    }
    if (!needsReload && prevEntry && prevEntry.disabled) {
      next.push(prevEntry);
      lastScan.set(d.dir, { manifest: d.manifest, main: d.main, css: d.css });
      continue;
    }
    // need to (re)load this dir
    try {
      const p = await loadOne(d, disabledIds);
      next.push(p);
    } catch (e) {
      next.push({ id: d.dir, name: d.dir, dir: d.dir, ext: null, error: e instanceof Error ? e.message : String(e), disabled: false });
    }
    lastScan.set(d.dir, { manifest: d.manifest, main: d.main, css: d.css });
  }
  // dirs that disappeared — revoke their resources
  for (const p of prev) {
    if (!seen.has(p.dir)) {
      revokeActive(p.dir, p.id);
      lastScan.delete(p.dir);
    }
  }
  setPluginLexicon(next.flatMap((p) => (p.disabled ? [] : p.ext?.lexicon ?? [])));
  setSlashFrom(next);
  return next;
}
