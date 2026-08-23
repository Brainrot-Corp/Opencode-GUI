import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Titlebar from "../components/Titlebar";
import Sidebar from "../components/Sidebar";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PermissionBar from "../components/PermissionBar";
import SettingsDrawer from "../components/SettingsDrawer";
import { useOpencode } from "../hooks/useOpencode";
import { useSettings } from "../hooks/useSettings";
import { playSound } from "../lib/sounds";

const SB_W_KEY = "oc.sb.w";
const SB_C_KEY = "oc.sb.c";

export default function ChatPage() {
  const oc = useOpencode();
  const { settings, update, updateSounds, updateColors, resetColors } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [sbW, setSbW] = useState(() => {
    const w = Number(localStorage.getItem(SB_W_KEY)) || 248;
    return Math.min(Math.max(170, w), 440);
  });
  const [sbClosed, setSbClosed] = useState(() => localStorage.getItem(SB_C_KEY) === "1");
  const [resizing, setResizing] = useState(false);

  // block WebView2 zoom hotkeys entirely: Ctrl+wheel / Ctrl +/-/0
  // and suppress the raw browser right-click menu (desktop app, not a page)
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && ["=", "+", "-", "0"].includes(e.key)) e.preventDefault();
    };
    const ctx = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    document.addEventListener("contextmenu", ctx);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
      document.removeEventListener("contextmenu", ctx);
    };
  }, []);

  // Ctrl+P toggles always-on-top — a plain window listener, so it naturally
  // only fires while the app is open and focused
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "p"
      ) {
        e.preventDefault();
        // same click noise as toggling via the titlebar pin
        playSound("click");
        update({ alwaysOnTop: !settings.alwaysOnTop });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settings.alwaysOnTop, update]);

  // Rust emits visibility://changed on tray click / Alt+Space / tray menu
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<boolean>("visibility://changed", (e) =>
      playSound(e.payload ? "show" : "hide"),
    ).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // generic click tick for every button that doesn't already play its own sound
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      if (b.closest(".win-controls")) return; // window buttons have their own
      if (b.classList.contains("send-btn")) return; // send has its own
      if (b.closest(".sb-toggle, .sb-expand")) return; // panels have their own
      if (b.closest(".sound-row")) return; // don't click while editing sounds
      playSound("click");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
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
      let lastTick = 0;
      setResizing(true);
      // keep the native Windows col-resize cursor locked during the whole drag
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (ev: MouseEvent) => {
        setSbW(Math.min(Math.max(170, startW + (ev.clientX - startX)), 440));
        const now = performance.now();
        if (now - lastTick > 70) {
          lastTick = now;
          playSound("resize");
        }
      };
      const up = () => {
        setResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [sbW],
  );

  function openSettings() {
    playSound("expand");
    setSettingsOpen(true);
  }

  function closeSettings() {
    playSound("collapse");
    setSettingsOpen(false);
  }

  return (
    <>
      <div className="noise" aria-hidden="true" />
      <div className="app">
        <Titlebar
          pinned={settings.alwaysOnTop}
          onTogglePin={() => update({ alwaysOnTop: !settings.alwaysOnTop })}
          onOpenSettings={openSettings}
          theme={settings.theme}
          onThemeChange={(t) => update({ theme: t })}
          mode={settings.mode}
          onModeChange={(m) => update({ mode: m })}
        />
        <SettingsDrawer
          open={settingsOpen}
          onClose={closeSettings}
          settings={settings}
          update={update}
          updateSounds={updateSounds}
          updateColors={updateColors}
          resetColors={resetColors}
        />
        <div
          className={`layout${resizing ? " no-anim" : ""}`}
          style={{ gridTemplateColumns: sbClosed ? "46px 1fr" : `${sbW}px 1fr` }}
        >
          <Sidebar
            sessions={oc.sessions}
            activeId={oc.activeId}
            width={sbW}
            collapsed={sbClosed}
            loading={oc.booting}
            resizing={resizing}
            onToggle={() => setSbClosed((v) => !v)}
            onStartResize={startResize}
            onNew={oc.newSession}
            onOpen={(id) => oc.openSession(id)}
            onDelete={(id) => oc.removeSession(id)}
          />
          <div className="main">
            {oc.error && <div className="banner">{oc.error}</div>}
            {!oc.activeId && !oc.booting && (
              <div className="messages">
                <p className="empty">
                  Select or create a session
                  <br />
                  to start.
                </p>
              </div>
            )}
            {(oc.activeId || oc.booting) && (
              <>
                <MessageList msgs={oc.msgs} busy={oc.busy} loading={oc.booting} />
                {oc.permission && (
                  <PermissionBar permission={oc.permission} onRespond={oc.respondToPermission} />
                )}
                <Composer
                  busy={oc.busy}
                  loadingModels={oc.booting}
                  providers={oc.providers}
                  modelSel={oc.modelSel}
                  defaultModel={oc.defaultModel}
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
