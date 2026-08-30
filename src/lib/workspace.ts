import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, setDirectory } from "../api";

const MAX_EXTRA = 5;
const LAST_WS_KEY = "oc.lastWorkspace";

export function getLastWorkspace(): string | null {
  try {
    const v = localStorage.getItem(LAST_WS_KEY);
    if (typeof v === "string" && v) return v;
    return null;
  } catch { return null; }
}
export function touchWorkspace(dir: string) {
  if (typeof dir !== "string") return;
  const t = dir.trim();
  try {
    if (!t) {
      localStorage.removeItem(LAST_WS_KEY);
    } else {
      localStorage.setItem(LAST_WS_KEY, t);
    }
    window.dispatchEvent(new CustomEvent("oc:last-workspace-changed", { detail: t }));
  } catch {}
}

function readExtras(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    return Array.isArray(raw.workspaces) ? raw.workspaces.filter((x: unknown) => typeof x === "string") : [];
  } catch { return []; }
}
// ponytail: re-reads localStorage immediately before write to minimize cross-tab
// lost-update race; if contention grows use BroadcastChannel lock (global lock, per-tab merge)
function writeExtras(list: string[]) {
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    raw.workspaces = list.slice(0, MAX_EXTRA);
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch {}
  window.dispatchEvent(new CustomEvent("oc:workspaces-changed"));
}
// transaction helper that re-reads before write and merges via updater — mitigates RC-05
function safeWriteExtras(updater: (prev: string[]) => string[]) {
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    const prev: string[] = Array.isArray(raw.workspaces) ? raw.workspaces.filter((x: unknown) => typeof x === "string") : [];
    raw.workspaces = updater(prev).slice(0, MAX_EXTRA);
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch {}
  window.dispatchEvent(new CustomEvent("oc:workspaces-changed"));
}
void writeExtras;
export function getExtraWorkspaces(): string[] { return readExtras(); }
export function getAllWorkspaces(): string[] {
  const primary = getDirectory();
  const extras = readExtras();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [primary, ...extras]) {
    const key = (d ?? "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
export async function addWorkspace(path: string, atIndex?: number): Promise<boolean> {
  const p = path.trim();
  if (!p) return false;
  const isDir = await invoke<boolean>("workspace_is_dir", { path: p }).catch(() => false);
  if (!isDir) return false;
  const primary = getDirectory().toLowerCase();
  if (p.toLowerCase() === primary) return false;
  // atomic read-modify-write: re-read latest inside transaction to avoid cross-tab lost update
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    let extras: string[] = Array.isArray(raw.workspaces) ? raw.workspaces.filter((x: unknown) => typeof x === "string") : [];
    const low = p.toLowerCase();
    if (extras.some((e) => e.toLowerCase() === low)) return false;
    if (extras.length >= MAX_EXTRA) return false;
    if (typeof atIndex === "number" && atIndex >= 0 && atIndex <= extras.length) extras.splice(atIndex, 0, p);
    else extras.push(p);
    raw.workspaces = extras.slice(0, MAX_EXTRA);
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch { return false; }
  window.dispatchEvent(new CustomEvent("oc:workspaces-changed"));
  return true;
}
export function removeWorkspace(path: string) {
  const low = path.toLowerCase();
  safeWriteExtras((prev) => prev.filter((e) => e.toLowerCase() !== low));
}
export function reorderWorkspaces(from: number, to: number) {
  safeWriteExtras((prev) => {
    if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });
}
export async function pickExtraWorkspace(atIndex?: number) {
  const def = getDirectory() || undefined;
  const path = await open({ directory: true, multiple: false, defaultPath: def });
  if (typeof path === "string") await addWorkspace(path, atIndex);
}

// persist + apply a workspace switch; full webview reload rebuilds
// sessions/messages/events for the new directory
export async function applyWorkspace(path: string) {
  touchWorkspace(path);
  setDirectory(path);
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    raw.workspace = path;
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch {
    // unreadable settings blob — reload still applies the session-side dir
  }
  // debug local builds survive devUrl origin changes via Rust file — must
  // complete before the reload tears down the IPC bridge
  try {
    await invoke("workspace_set", { path });
  } catch {}
  setTimeout(() => location.reload(), 50);
}

export async function pickWorkspace() {
  let def: string | undefined;
  try {
    def = getDirectory() || JSON.parse(localStorage.getItem("oc.settings") ?? "{}").workspace || undefined;
  } catch {
    def = getDirectory() || undefined;
  }
  // also try Rust last path as fallback so empty localStorage (dev origin)
  // still opens dialog at previous location
  if (!def) {
    try {
      const saved = await invoke<string>("workspace_get");
      if (saved) def = saved;
    } catch {}
  }
  const path = await open({ directory: true, multiple: false, defaultPath: def });
  if (typeof path === "string") await applyWorkspace(path);
}
