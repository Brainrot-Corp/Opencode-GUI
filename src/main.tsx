import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./styles/tokens.css";
import "./styles/syntax.css";
import "./styles/layout.css";
import { getDirectory, setDirectory } from "./api";

// debug local builds use http://localhost:1420 origin — localStorage there is
// separate from the release tauri://localhost origin, so the last workspace
// would appear lost after a dev rebuild. Rust's app_config_dir file survives
// both origins and seeds the frontend before first paint.
async function hydrateWorkspace() {
  try {
    const saved = (await invoke<string>("workspace_get").catch(() => ""))?.trim() ?? "";
    let lsWs = "";
    try {
      const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
      lsWs = typeof raw.workspace === "string" ? raw.workspace.trim() : "";
    } catch {}
    if (saved && !lsWs) {
      // Rust has it, frontend doesn't (dev first launch) — seed both
      try {
        const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
        raw.workspace = saved;
        localStorage.setItem("oc.settings", JSON.stringify(raw));
      } catch {
        localStorage.setItem("oc.settings", JSON.stringify({ workspace: saved }));
      }
      if (getDirectory().trim() !== saved) setDirectory(saved);
    } else if (!saved && lsWs) {
      // frontend has it, Rust doesn't (upgraded install) — backfill Rust
      invoke("workspace_set", { path: lsWs }).catch(() => {});
      if (getDirectory().trim() !== lsWs) setDirectory(lsWs);
    } else if (saved && lsWs && saved !== lsWs) {
      // both exist but diverged — trust localStorage (most recent UI) and
      // push to Rust so next debug launch is consistent
      invoke("workspace_set", { path: lsWs }).catch(() => {});
    }
  } catch {}
}

// no OS glass (Win10, Mica unavailable) → paint an opaque backdrop instead
invoke<boolean>("os_glass")
  .then((g) => {
    if (!g) document.documentElement.classList.add("no-glass");
  })
  .catch(() => {});

// sidebar resize cursor = the user's live Windows pointer scheme (WebView2
// ignores schemes for CSS cursors, so Rust ships the real one as a data URL)
invoke<{ url: string; x: number; y: number }>("resize_cursor")
  .then(({ url, x, y }) =>
    document.documentElement.style.setProperty(
      "--cur-colresize",
      `url("${url}") ${x} ${y}`,
    ),
  )
  .catch(() => {});

// TEMP crash diagnostics — every JS error lands in %TEMP%\oc-gui-debug.log
const logErr = (kind: string, e: unknown) => {
  const msg = e instanceof Error ? `${e.stack ?? e.message}` : String(e);
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
};
window.addEventListener("error", (e) => logErr("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => logErr("promise", e.reason));
const origErr = console.error;
console.error = (...a) => {
  logErr("console.error", a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" | "));
  origErr(...a);
};

hydrateWorkspace().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
});
