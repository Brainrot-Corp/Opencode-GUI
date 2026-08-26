import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { playSound } from "../lib/sounds";
import type { Mode } from "../hooks/useSettings";
import type { ThemeMeta } from "../lib/themes";
import ThemeSelect from "./ThemeSelect";

// titlebar height — keep in sync with layout.css
const TB_H = 42;

export default function Titlebar({
  pinned,
  onTogglePin,
  closeOnX,
  onOpenSettings,
  themes,
  theme,
  onThemeChange,
  mode,
  onModeChange,
  modes,
  talking,
  debriefing,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
  // true = the X button really quits instead of hiding to tray
  closeOnX?: boolean;
  onOpenSettings?: () => void;
  themes?: ThemeMeta[];
  theme?: string;
  onThemeChange?: (t: string) => void;
  mode?: Mode;
  onModeChange?: (m: Mode) => void;
  // variations the active theme provides — hidden toggle when only one
  modes?: Mode[];
  // TTS queue draining / audio audible — show the speaking indicator
  talking?: boolean;
  debriefing?: boolean;
}) {
  // invisible drag bar: when a dialog/drawer scrim covers the titlebar, its
  // presses would normally die on the dim layer. This capture listener
  // grabs any press that lands on the strip over DEAD scrim space and turns
  // it into a native window drag — without covering real controls.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button !== 0 || e.detail !== 1) return;
      if (e.clientY > TB_H) return;
      const t = e.target as HTMLElement | null;
      if (!t || t.closest(".titlebar")) return; // bare titlebar drags itself
      if (!t.closest(".dlg-scrim, .drawer-scrim")) return; // only dead dim space
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
        <span>OpenCode 1.5.4</span>
      </div>
      <div className="win-controls">
        {debriefing && (
          <span className="debrief-indicator" data-tip="Debrief in progress — preparing summary">
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
            <em>Debriefing</em>
            <i className="debrief-dot" aria-hidden="true" />
          </span>
        )}
        <ThemeSelect themes={themes ?? []} value={theme ?? "cyan"} onChange={(t) => onThemeChange?.(t)} />
        {(!modes || modes.length > 1) && (
          <button
            className="icon-btn"
            data-tip={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
            onClick={() => {
              playSound("click");
              onModeChange?.(mode === "light" ? "dark" : "light");
            }}
          >
            <i className={`fa-solid ${mode === "light" ? "fa-moon" : "fa-regular fa-sun"}`} />
          </button>
        )}
        <button
          className={`debrief-indicator speech-indicator${talking ? "" : " idle"}`}
          data-tip={talking ? "Stop speech" : "Not speaking"}
          aria-label={talking ? "Stop speech" : "Not speaking"}
          onClick={() => {
            if (!talking) return;
            playSound("click");
            window.dispatchEvent(new Event("oc:tts-stop"));
          }}
        >
          <i className="fa-solid fa-volume-high" aria-hidden="true" />
          <em>Speaking</em>
          <i className="debrief-dot" aria-hidden="true" />
        </button>
        <span className="ctrl-sep" />
        <button className="icon-btn" data-tip="Settings" onClick={() => onOpenSettings?.()}>
          <i className="fa-solid fa-gear" />
        </button>
        <button
          className={`icon-btn${pinned ? " on" : ""}`}
          data-tip={pinned ? "Unpin (always on top)" : "Pin to top (always on top)"}
          aria-pressed={pinned ?? false}
          onClick={() => onTogglePin?.()}
        >
          <i className={`fa-solid fa-thumbtack${pinned ? " fa-rotate-45" : ""}`} />
        </button>
        <span className="ctrl-sep" />
        <button
          className="icon-btn"
          data-tip="Minimize"
          onClick={() => {
            playSound("hide");
            getCurrentWindow().minimize();
          }}
        >
          <i className="fa-solid fa-minus" />
        </button>
        <button
          className="icon-btn"
          data-tip="Maximize / restore"
          onClick={() => {
            playSound("maximize");
            getCurrentWindow().toggleMaximize();
          }}
        >
          <i className="fa-regular fa-square" />
        </button>
        <button
          className="icon-btn close"
          data-tip={closeOnX ? "Quit OpenCode (Ctrl: hide to tray)" : "Hide to tray (Ctrl: quit)"}
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