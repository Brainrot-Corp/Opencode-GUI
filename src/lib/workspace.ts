import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, setDirectory } from "../api";
import { normWorkspace } from "./platform";

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
  let seenEmpty = false;
  for (const d of [primary, ...extras]) {
    const t = (d ?? "").trim();
    if (!t) {
      if (seenEmpty) continue;
      seenEmpty = true;
      seen.add("__EMPTY__");
      out.push("");
      continue;
    }
    const key = normWorkspace(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
export async function addWorkspace(path: string, atIndex?: number): Promise<boolean> {
  const p = path.trim();
  if (!p) return false;
  // SSH workspaces are validated by the SSH dialog (remote_test) up front —
  // password-auth tunnels can't pass a detached is-dir probe, so skip the
  // local gate and let the first server call surface any staleness.
  if (!p.startsWith("ssh://")) {
    const isDir = await invoke<boolean>("workspace_is_dir", { path: p }).catch(() => false);
    if (!isDir) return false;
  }
  const primary = getDirectory().trim();
  const norm = (s: string) => normWorkspace(s);
  if (norm(p) === norm(primary)) return false;
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    let extras: string[] = Array.isArray(raw.workspaces) ? raw.workspaces.filter((x: unknown) => typeof x === "string") : [];
    if (extras.some((e) => norm(e) === norm(p))) return false;
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
  const norm = (s: string) => normWorkspace(s);
  const target = norm(path.trim());
  safeWriteExtras((prev) => prev.filter((e) => norm(e) !== target));
}
// swap one added (non-primary) workspace slot for a new folder in place;
// the primary workspace is handled by applyWorkspace instead
export async function replaceWorkspace(oldPath: string, newPath: string): Promise<boolean> {
  const oldP = oldPath.trim();
  const p = newPath.trim();
  if (!oldP || !p) return false;
  const norm = (s: string) => normWorkspace(s);
  if (norm(p) === norm(oldP)) return false;
  if (!p.startsWith("ssh://")) {
    const isDir = await invoke<boolean>("workspace_is_dir", { path: p }).catch(() => false);
    if (!isDir) return false;
  }
  const primary = getDirectory().trim();
  if (norm(p) === norm(primary)) return false;
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    const extras: string[] = Array.isArray(raw.workspaces) ? raw.workspaces.filter((x: unknown) => typeof x === "string") : [];
    const idx = extras.findIndex((e) => norm(e) === norm(oldP));
    if (idx < 0) return false;
    if (extras.some((e, i) => i !== idx && norm(e) === norm(p))) return false;
    extras[idx] = p;
    raw.workspaces = extras.slice(0, MAX_EXTRA);
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch { return false; }
  window.dispatchEvent(new CustomEvent("oc:workspaces-changed"));
  return true;
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

// persist + apply a workspace switch live (no reload): Sidebar, Terminal,
// GitPanel and sessions converge via oc:workspaces-changed + the 2s SSE
// tick, so busy sessions on untouched workspaces keep streaming.
export async function applyWorkspace(path: string) {
  touchWorkspace(path);
  setDirectory(path);
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    raw.workspace = path;
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch {
    // unreadable settings blob — sessions still follow the api dir
  }
  // debug local builds survive devUrl origin changes via Rust file
  try {
    await invoke("workspace_set", { path });
  } catch {}
  window.dispatchEvent(new CustomEvent("oc:workspaces-changed"));
}

// reset to a clean slate: primary -> "" (server cwd), extras dropped.
// Terminals are closed via oc:terms-close-all (Terminal kills the PTYs and
// clears its persisted list); sessions stay server-side and reappear if a
// workspace is re-added.
export async function closeAllWorkspaces() {
  touchWorkspace("");
  setDirectory("");
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    raw.workspace = "";
    raw.workspaces = [];
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch {
    // unreadable settings blob — sessions still follow the api dir
  }
  // debug local builds survive devUrl origin changes via Rust file
  try {
    await invoke("workspace_set", { path: "" });
  } catch {}
  window.dispatchEvent(new CustomEvent("oc:workspaces-changed"));
  window.dispatchEvent(new Event("oc:terms-close-all"));
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
