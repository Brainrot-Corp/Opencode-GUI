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
  ext: PluginExt | null;
  error: string;
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

  const out: LoadedPlugin[] = [];
  for (const d of dirs) {
    try {
      const man = parseManifest(d.dir, d.manifest);
      if (!man || !d.main.trim()) continue; // empty or half-written folder
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
      if (!raw) continue;
      if (typeof d.css === "string" && d.css.trim()) {
        const style = document.createElement("style");
        style.dataset.plugin = man.id;
        style.textContent = d.css;
        document.head.appendChild(style);
        mine.push({ style });
      }
      out.push({ id: man.id, name: man.name, ext: { ...raw, id: man.id, name: man.name }, error: "" });
    } catch (e) {
      out.push({ id: d.dir, name: d.dir, ext: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // plugins can't import host modules — the loader merges their lexicon
  // contributions (replaced wholesale on hot reload)
  setPluginLexicon(out.flatMap((p) => p.ext?.lexicon ?? []));
  return out;
}
