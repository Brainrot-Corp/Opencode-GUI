import { open } from "@tauri-apps/plugin-dialog";
import { setDirectory } from "../api";

// persist + apply a workspace switch; full webview reload rebuilds
// sessions/messages/events for the new directory
export function applyWorkspace(path: string) {
  setDirectory(path);
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    raw.workspace = path;
    localStorage.setItem("oc.settings", JSON.stringify(raw));
  } catch {
    // unreadable settings blob — reload still applies the session-side dir
  }
  setTimeout(() => location.reload(), 50);
}

export async function pickWorkspace() {
  const path = await open({ directory: true, multiple: false });
  if (typeof path === "string") applyWorkspace(path);
}
