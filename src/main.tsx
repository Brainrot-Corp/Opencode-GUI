import React from "react";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
