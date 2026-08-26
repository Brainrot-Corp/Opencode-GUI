import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./styles/tokens.css";
import "./styles/syntax.css";
import "./styles/layout.css";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
