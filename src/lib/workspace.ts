import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getDirectory, setDirectory } from "../api";

// persist + apply a workspace switch; full webview reload rebuilds
// sessions/messages/events for the new directory
export async function applyWorkspace(path: string) {
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
