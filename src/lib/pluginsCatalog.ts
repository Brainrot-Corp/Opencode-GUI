// plugin browser catalog — fetches the default_plugins folder from GitHub so new
// upstream plugins appear without shipping a list; mirrors piper.ts caching but
// 1-day TTL per spec and supports arbitrary URL installs.
import { invoke } from "@tauri-apps/api/core";

export const PLUGINS_API =
  "https://api.github.com/repos/Brainrot-Corp/Opencode-GUI/contents/default_plugins";
export const PLUGINS_RAW_BASE =
  "https://raw.githubusercontent.com/Brainrot-Corp/Opencode-GUI/main/default_plugins/";

const CACHE_KEY = "oc.plugins.catalog";
const CACHE_TTL = 12 * 3600 * 1000; // 12 hours

export type PluginCatalogEntry = {
  id: string;
  name: string;
  version?: string;
  description?: string;
};

// pure parser — GitHub contents API returns [{name,type}] for a folder
export function parsePluginsApi(body: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(j)) return [];
  const out: string[] = [];
  for (const e of j) {
    const r = e as { name?: unknown; type?: unknown };
    if (typeof r.name === "string" && r.type === "dir") out.push(r.name);
  }
  return out.sort();
}

// raw URL helper for main/css/manifest
export function pluginRawUrl(id: string, file: string): string {
  return `${PLUGINS_RAW_BASE}${id}/${file}`;
}

type Page = { status: number; body: string };

async function fetchText(url: string): Promise<string> {
  const r = await invoke<Page>("http_json", { method: "GET", url, headers: {}, body: null });
  if (r.status < 200 || r.status >= 300) throw new Error(`fetch ${url} → ${r.status}`);
  return r.body;
}

async function fetchManifest(id: string): Promise<PluginCatalogEntry | null> {
  try {
    const body = await fetchText(pluginRawUrl(id, "plugin.json"));
    const m = JSON.parse(body) as Record<string, unknown>;
    return {
      id: typeof m.id === "string" && m.id ? m.id : id,
      name: typeof m.name === "string" && m.name ? m.name : id,
      version: typeof m.version === "string" ? m.version : undefined,
      description: typeof m.description === "string" ? m.description : undefined,
    };
  } catch {
    return { id, name: id };
  }
}

// load catalog with 12h cache; falls back to cached or empty on error
export async function loadPluginsCatalog(force = false): Promise<PluginCatalogEntry[]> {
  if (!force) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw) as { at: number; entries: PluginCatalogEntry[] };
        if (Array.isArray(c.entries) && c.entries.length > 0 && Date.now() - c.at < CACHE_TTL)
          return c.entries;
      }
    } catch {}
  }
  try {
    const r = await invoke<Page>("http_json", {
      method: "GET",
      url: PLUGINS_API,
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "opencode-gui" },
      body: null,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`catalog ${r.status}`);
    const ids = parsePluginsApi(r.body);
    if (!ids.length) throw new Error("empty catalog");
    // fetch manifests in parallel — small files, 10s timeout already
    const entries = (await Promise.all(ids.map(fetchManifest))).filter(Boolean) as PluginCatalogEntry[];
    if (entries.length) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), entries }));
      return entries;
    }
  } catch {}
  // fallback: cached even if stale, else empty
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { at: number; entries: PluginCatalogEntry[] };
      if (Array.isArray(c.entries) && c.entries.length) return c.entries;
    }
  } catch {}
  return [];
}

// --- URL install helpers -----------------------------------------------

// normalize a user-pasted URL to a raw base folder (no trailing file)
export function normalizePluginUrl(input: string): string {
  let u = input.trim();
  if (!u) return "";
  // github.com/Brainrot-Corp/Opencode-GUI/tree/main/default_plugins/foo → raw
  if (u.includes("github.com")) {
    u = u.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/tree/", "/").replace("/blob/", "/");
  }
  // strip trailing file
  if (u.endsWith("/plugin.json")) u = u.slice(0, -"/plugin.json".length);
  else if (u.endsWith("/main.js")) u = u.slice(0, -"/main.js".length);
  else if (u.endsWith("/styles.css")) u = u.slice(0, -"/styles.css".length);
  u = u.replace(/\/+$/, "");
  return u;
}

export function dirFromUrl(base: string): string {
  const parts = base.split("/").filter(Boolean);
  return parts[parts.length - 1] || "plugin";
}

// fetch plugin files from any https base (catalog or URL); css may be missing
export async function fetchPluginFiles(base: string): Promise<{ manifest: string; main: string; css: string }> {
  const b = base.replace(/\/+$/, "");
  const manifest = await fetchText(`${b}/plugin.json`);
  const main = await fetchText(`${b}/main.js`);
  let css = "";
  try {
    css = await fetchText(`${b}/styles.css`);
  } catch {
    css = "";
  }
  return { manifest, main, css };
}
