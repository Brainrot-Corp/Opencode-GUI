// clipboard helper — tries Tauri clipboard-manager (writeText/readText) then falls back to navigator.clipboard
// The Tauri plugin is optional at runtime; if its invoke fails we silently use the web API.

async function tauriWrite(text: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // plugin identifier: "plugin:clipboard-manager|writeText" (Tauri v2)
    await invoke("plugin:clipboard-manager|writeText", { text });
    return true;
  } catch {
    return false;
  }
}

async function tauriRead(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const t = await invoke<string>("plugin:clipboard-manager|readText");
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

export async function clipboardWrite(text: string): Promise<void> {
  if (await tauriWrite(text)) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // last resort — execCommand path for older webview
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {}
  }
}

export async function clipboardRead(): Promise<string> {
  const t = await tauriRead();
  if (t !== null) return t;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

export async function clipboardHasText(): Promise<boolean> {
  try {
    const t = await clipboardRead();
    return t.length > 0;
  } catch {
    return false;
  }
}
