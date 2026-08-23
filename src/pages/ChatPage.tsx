import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Titlebar from "../components/Titlebar";
import Sidebar from "../components/Sidebar";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PermissionBar from "../components/PermissionBar";
import SettingsDrawer from "../components/SettingsDrawer";
import DiffPanel from "../components/DiffPanel";
import TooltipLayer from "../components/TooltipLayer";
import { HelpDialog, ShareDialog } from "../components/CommandDialog";
import { useOpencode } from "../hooks/useOpencode";
import { THEMES, useSettings } from "../hooks/useSettings";
import { pickWorkspace } from "../lib/workspace";
import { playSound } from "../lib/sounds";

const SB_W_KEY = "oc.sb.w";
const SB_C_KEY = "oc.sb.c";

export default function ChatPage() {
  const oc = useOpencode();
  const { settings, update, updateSounds, updateColors, resetColors } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

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

  // slash-command UI handoffs (/themes /scheme /diff /settings)
  useEffect(() => {
    const themes = () => {
      const ids = THEMES.map((t) => t.id);
      update({ theme: ids[(ids.indexOf(settings.theme) + 1) % ids.length] });
    };
    const scheme = () => update({ mode: settings.mode === "dark" ? "light" : "dark" });
    window.addEventListener("oc:themes", themes);
    window.addEventListener("oc:scheme", scheme);
    return () => {
      window.removeEventListener("oc:themes", themes);
      window.removeEventListener("oc:scheme", scheme);
    };
  }, [settings.theme, settings.mode, update]);

  useEffect(() => {
    const diff = () => setDiffOpen((v) => !v);
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener("oc:diff", diff);
    window.addEventListener("oc:settings", openSettings);
    return () => {
      window.removeEventListener("oc:diff", diff);
      window.removeEventListener("oc:settings", openSettings);
    };
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
      <TooltipLayer />
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
            busyIds={oc.busyIds}
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
                {settings.workspace && (
                  <div className="stage-head" data-tip={settings.workspace}>
                    <i className="fa-solid fa-folder-open" />
                    <span className="mono">{settings.workspace}</span>
                  </div>
                )}
                <MessageList
                  msgs={oc.msgs}
                  busy={oc.busy}
                  loading={oc.booting}
                  onRevert={oc.revertTo}
                />
                {oc.revertId && (
                  <div className="revert-banner">
                    <i className="fa-solid fa-clock-rotate-left" />
                    Viewing an earlier version of this conversation.
                    <button onClick={oc.unrevert}>
                      <i className="fa-solid fa-rotate-left" />
                      Undo rewind
                    </button>
                  </div>
                )}
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
                  onSend={oc.submit}
                  onAbort={oc.abort}
                  onToggleDiff={() => setDiffOpen((v) => !v)}
                  onPickWorkspace={() => pickWorkspace()}
                  workspace={settings.workspace}
                  commands={oc.cmdList}
                  onCommandsOpen={oc.refreshCommands}
                />
              </>
            )}
          </div>
        </div>
        {oc.dialog?.kind === "help" && (
          <HelpDialog commands={oc.cmdList} onClose={oc.closeDialog} />
        )}
        {oc.dialog?.kind === "share" && (
          <ShareDialog url={oc.dialog.url} onClose={oc.closeDialog} />
        )}
        {diffOpen && oc.activeId && (
          <DiffPanel sessionId={oc.activeId} onClose={() => setDiffOpen(false)} />
        )}
      </div>
    </>
  );
}
