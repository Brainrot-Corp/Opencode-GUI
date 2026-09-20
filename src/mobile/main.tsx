// Mobile entry — phase 2 of docs/mobile-companion.md: the phone app shell
// (Connect + Notifications screens). Talks to the oc-relay as a "phone"
// device over the same protocol the browser shim uses; see relayClient.ts.

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "../styles/mobile.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
