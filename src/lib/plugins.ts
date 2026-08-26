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

export type PluginApi = {
  id: string;
  invoke: typeof invoke;
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useRef: typeof useRef;
  // the live oc.settings blob (persisted synchronously on every change)
  settings: () => Record<string, unknown>;
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
  // documentation rows appended to the Info dialog's tabs, grouped under the
  // plugin name — same [label, description] shape the built-in groups use
  info?: {
    voice?: [string, string][];
    keys?: [string, string][];
  };
};

export type LoadedPlugin = {
  id: string;
  name: string;
  dir: string;
  ext: PluginExt | null;
  error: string;
  disabled: boolean;
};

// pure manifest reader — node tests exercise this directly
export function parseManifest(dir: string, raw: string): { id: string; name: string } | null {
  try {
    const m = JSON.parse(stripComments(raw));
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    return {
      id: typeof m.id === "string" && m.id ? m.id : dir,
      name: typeof m.name === "string" && m.name ? m.name : dir,
    };
  } catch {
    return null;
  }
}

// disabled persistence — localStorage `oc.plugins.disabled` (string[] of ids)
const DISABLED_KEY = "oc.plugins.disabled";

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

// assets of the last load — revoked/replaced wholesale on hot reload
let active: { url?: string; style?: HTMLStyleElement }[] = [];

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  for (const a of active) {
    if (a.url) URL.revokeObjectURL(a.url);
    a.style?.remove();
  }
  const mine: { url?: string; style?: HTMLStyleElement }[] = [];
  active = mine;

  const dirs = await invoke<
    { dir: string; manifest: string; main: string; css: string }[]
  >("plugins_scan").catch(() => []);

  const disabledIds = getDisabledIds();
  const out: LoadedPlugin[] = [];
  for (const d of dirs) {
    try {
      const man = parseManifest(d.dir, d.manifest);
      if (!man) continue;
      const disabled = disabledIds.has(man.id) || disabledIds.has(d.dir);
      if (disabled) {
        out.push({ id: man.id, name: man.name, dir: d.dir, ext: null, error: "", disabled: true });
        continue;
      }
      if (!d.main.trim()) {
        // empty or half-written folder — surface as error, not disabled
        out.push({ id: man.id, name: man.name, dir: d.dir, ext: null, error: "missing main.js", disabled: false });
        continue;
      }
      const url = URL.createObjectURL(new Blob([d.main], { type: "text/javascript" }));
      const mod = await import(/* @vite-ignore */ url);
      mine.push({ url });
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
      };
      const raw = typeof mod.default === "function" ? await mod.default(api) : null;
      if (!raw) {
        out.push({ id: man.id, name: man.name, dir: d.dir, ext: null, error: "", disabled: false });
        continue;
      }
      if (typeof d.css === "string" && d.css.trim()) {
        const style = document.createElement("style");
        style.dataset.plugin = man.id;
        style.textContent = d.css;
        document.head.appendChild(style);
        mine.push({ style });
      }
      out.push({ id: man.id, name: man.name, dir: d.dir, ext: { ...raw, id: man.id, name: man.name }, error: "", disabled: false });
    } catch (e) {
      out.push({ id: d.dir, name: d.dir, dir: d.dir, ext: null, error: e instanceof Error ? e.message : String(e), disabled: false });
    }
  }
  // plugins can't import host modules — the loader merges their lexicon
  // contributions (replaced wholesale on hot reload) — disabled plugins excluded
  setPluginLexicon(out.flatMap((p) => (p.disabled ? [] : p.ext?.lexicon ?? [])));
  return out;
}
