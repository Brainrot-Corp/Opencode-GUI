import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { playSound } from "../lib/sounds";
import { useTranslation } from "../lib/i18n";

// titlebar height — keep in sync with layout.css
const TB_H = 42;

export default function Titlebar({
  pinned,
  onTogglePin,
  closeOnX,
  onOpenSettings,
  onOpenPlugins,
  hasPluginUpdate,
  talking,
  debriefing,
  titlebarExtras,
  onToggleAgents,
  agentsOpen,
  agentsHotkey,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
  // true = the X button really quits instead of hiding to tray
  closeOnX?: boolean;
  onOpenSettings?: () => void;
  onOpenPlugins?: () => void;
  hasPluginUpdate?: boolean;
  // TTS queue draining / audio audible — show the speaking indicator
  talking?: boolean;
  debriefing?: boolean;
  // plugin-provided titlebar icons (e.g. Notepad) rendered before Settings
  titlebarExtras?: React.ReactNode;
  onToggleAgents?: () => void;
  agentsOpen?: boolean;
  agentsHotkey?: string | null;
}) {
  const { t } = useTranslation();
  // invisible drag bar: when a dialog/drawer scrim covers the titlebar, its
  // presses would normally die on the dim layer. This capture listener
  // grabs any press that lands on the strip over DEAD scrim space and turns
  // it into a native window drag — without covering real controls.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button !== 0 || e.detail !== 1) return;
      if (e.clientY > TB_H) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(".titlebar")) return; // bare titlebar drags itself
      if (!target.closest(".dlg-scrim, .drawer-scrim")) return; // only dead dim space
      // never steal from live content stacked in the strip (panel headers,
      // menus, buttons peeking through)
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      if (
        stack.some((el) =>
          el.closest(
            ".dlg-panel, .settings-drawer, button, input, select, textarea, a, label, [role]",
          ),
        )
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      getCurrentWindow().startDragging();
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, []);

  return (
    <header
      className="titlebar"
      // no data-tauri-drag-region: dragging is done manually below, and
      // dblclick replicates the stock caption behavior (maximize / restore)
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // buttons handle their own clicks; only bare titlebar drags the window
        if ((e.target as HTMLElement).closest("button")) return;
        // skip the second press of a double-click: startDragging would enter
        // a native drag loop that swallows the click, killing onDoubleClick
        if (e.detail !== 1) return;
        getCurrentWindow().startDragging();
      }}
      onDoubleClick={(e) => {
        // same guard as the drag handler — controls never toggle maximize
        if ((e.target as HTMLElement).closest("button")) return;
        playSound("maximize");
        getCurrentWindow().toggleMaximize();
      }}
    >
      <div className="brand">
        <i />
        <span>OpenCode</span>
      </div>
      <div className="win-controls">
        {titlebarExtras}
        <button
          className={`icon-btn${agentsOpen ? " on" : ""}`}
          data-tip={agentsHotkey ? t("titlebar.agentsTip", { hotkey: agentsHotkey }) : t("titlebar.agents")}
          aria-pressed={!!agentsOpen}
          onClick={() => onToggleAgents?.()}
        >
          <i className="fa-solid fa-diagram-project" />
        </button>
        <button className="icon-btn" data-tip={hasPluginUpdate ? t("titlebar.plugins.update") : t("titlebar.plugins.default")} onClick={() => onOpenPlugins?.()}>
          <i className="fa-solid fa-puzzle-piece" />
          {hasPluginUpdate && <span className="plugin-update-dot" aria-hidden="true" />}
        </button>
        <span className="ctrl-sep" />
        {debriefing && (
          <span className="debrief-indicator" data-tip={t("titlebar.debriefing")}>
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
            <em>{t("titlebar.debriefingLabel")}</em>
            <i className="debrief-dot" aria-hidden="true" />
          </span>
        )}
        <button
          className={`debrief-indicator speech-indicator${talking ? "" : " idle"}`}
          data-tip={talking ? t("titlebar.speakingTip") : t("titlebar.notSpeakingTip")}
          aria-label={talking ? t("titlebar.speakingTip") : t("titlebar.notSpeakingTip")}
          onClick={() => {
            if (!talking) return;
            playSound("click");
            window.dispatchEvent(new Event("oc:tts-stop"));
          }}
        >
          <i className="fa-solid fa-volume-high" aria-hidden="true" />
          <em>{talking ? t("titlebar.speaking") : t("titlebar.notSpeakingLabel")}</em>
          <i className="debrief-dot" aria-hidden="true" />
        </button>
        <span className="ctrl-sep" />
        <button className="icon-btn" data-tip={t("titlebar.settingsTip")} onClick={() => onOpenSettings?.()}>
          <i className="fa-solid fa-gear" />
        </button>
        <button
          className={`icon-btn${pinned ? " on" : ""}`}
          data-tip={pinned ? t("titlebar.pinOn") : t("titlebar.pinOff")}
          aria-pressed={pinned ?? false}
          onClick={() => onTogglePin?.()}
        >
          <i className={`fa-solid fa-thumbtack${pinned ? " fa-rotate-45" : ""}`} />
        </button>
        <span className="ctrl-sep" />
        <button
          className="icon-btn"
          data-tip={t("titlebar.minimize")}
          onClick={() => {
            playSound("hide");
            getCurrentWindow().minimize();
          }}
        >
          <i className="fa-solid fa-minus" />
        </button>
        <button
          className="icon-btn"
          data-tip={t("titlebar.maximize")}
          onClick={() => {
            playSound("maximize");
            getCurrentWindow().toggleMaximize();
          }}
        >
          <i className="fa-regular fa-square" />
        </button>
        <button
          className="icon-btn close"
          data-tip={closeOnX ? t("titlebar.close.quit") : t("titlebar.close.hide")}
          onClick={(e) => {
            playSound("close");
            // holding Ctrl inverts the configured behavior
            const quit = e.ctrlKey ? !closeOnX : closeOnX;
            if (quit) {
              window.setTimeout(() => getCurrentWindow().close(), 130);
            } else {
              // Rust-side hide: applies the pre-hide size reset like every
              // other path to the tray (Alt+Space, tray click, tray menu)
              window.setTimeout(() => invoke("hide_to_tray"), 130);
            }
          }}
        >
          <i className="fa-solid fa-xmark" />
        </button>
      </div>
    </header>
  );
}
