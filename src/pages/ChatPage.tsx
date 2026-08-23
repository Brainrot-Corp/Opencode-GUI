import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Titlebar from "../components/Titlebar";
import Sidebar from "../components/Sidebar";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PermissionBar from "../components/PermissionBar";
import { useOpencode } from "../hooks/useOpencode";

const SB_W_KEY = "oc.sb.w";
const SB_C_KEY = "oc.sb.c";

export default function ChatPage() {
  const oc = useOpencode();

  const [sbW, setSbW] = useState(() => {
    const w = Number(localStorage.getItem(SB_W_KEY)) || 248;
    return Math.min(Math.max(170, w), 440);
  });
  const [sbClosed, setSbClosed] = useState(() => localStorage.getItem(SB_C_KEY) === "1");
  const [resizing, setResizing] = useState(false);

  // WebView2 page zoom (Ctrl+scroll) persists silently — always start at 100%
  useEffect(() => {
    getCurrentWebview().setZoom(1).catch(() => {});
  }, []);

  // and block zoom hotkeys entirely: Ctrl+wheel / Ctrl +/-/0
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && ["=", "+", "-", "0"].includes(e.key)) e.preventDefault();
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SB_W_KEY, String(sbW));
  }, [sbW]);
  useEffect(() => {
    localStorage.setItem(SB_C_KEY, sbClosed ? "1" : "0");
  }, [sbClosed]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sbW;
      setResizing(true);
      const move = (ev: MouseEvent) => {
        setSbW(Math.min(Math.max(170, startW + (ev.clientX - startX)), 440));
      };
      const up = () => {
        setResizing(false);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [sbW],
  );

  return (
    <>
      <div className="noise" aria-hidden="true" />
      <div className="app">
        <Titlebar />
        <div
          className={`layout${resizing ? " no-anim" : ""}`}
          style={{ gridTemplateColumns: sbClosed ? "46px 1fr" : `${sbW}px 1fr` }}
        >
          <Sidebar
            sessions={oc.sessions}
            activeId={oc.activeId}
            width={sbW}
            collapsed={sbClosed}
            onToggle={() => setSbClosed((v) => !v)}
            onStartResize={startResize}
            onNew={oc.newSession}
            onOpen={(id) => oc.openSession(id)}
            onDelete={(id) => oc.removeSession(id)}
          />
          <div className="main">
            {/* TEMP boot diagnostics — remove once stable */}
            <div className="diag">
              server ✓ · sessions {oc.sessions.length} · models{" "}
              {oc.providers.reduce((n, g) => n + g.models.length, 0)} · stream{" "}
              {oc.live ? "live" : "down"}
              {oc.error ? ` · ERROR: ${oc.error}` : ""}
            </div>
            {oc.error && <div className="banner">{oc.error}</div>}
            {!oc.activeId ? (
              <p className="empty">Select or create a session to start.</p>
            ) : (
              <>
                <MessageList msgs={oc.msgs} busy={oc.busy} />
                {oc.permission && (
                  <PermissionBar permission={oc.permission} onRespond={oc.respondToPermission} />
                )}
                <Composer
                  busy={oc.busy}
                  providers={oc.providers}
                  modelSel={oc.modelSel}
                  onModelSelect={oc.setModelSel}
                  onSend={oc.send}
                  onAbort={oc.abort}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
