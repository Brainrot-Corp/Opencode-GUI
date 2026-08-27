import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings } from "./useSettings";
import { playSound } from "../lib/sounds";
import { UI_SCALES } from "../lib/uiScale";

// surfaces that own a single Escape (menus, dialogs, popups) — while any of
// them is open the double-Escape stop gesture stands down entirely and the
// keypress goes to whatever handles closing that surface. NOTE: only pick
// classes that are MOUNTED only while open — .drawer-scrim for one stays in
// the DOM forever and just toggles its .open class
const OVERLAY_SEL =
  ".cmd-menu, .model-menu, .ctx-menu, .dlg-scrim, .drawer-scrim.open, .permission-bar";
// window in which the second Escape completes the stop gesture
const STOP_ARM_MS = 4000;

// window/document-level listeners ChatPage used to inline: embedded-browser
// link capture, WebView2 hotkey suppression, Ctrl+P pin, tray sounds,
// slash-command UI handoffs (oc:* events), and the generic button tick.
export function useGlobalShortcuts({
  settings,
  update,
  openBrowser,
  toggleDiff,
  openSettings,
  abort,
  busy,
  themeIds,
  activeModes,
  onCycleSessions,
  onCloseSession,
  onToggleTerm,
  onToggleSidebar,
  onOpenWorkspace,
  onNewInstance,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  openBrowser: (url: string) => void;
  toggleDiff: () => void;
  openSettings: () => void;
  // double-Escape stops generation — same as the stop button
  abort: () => void;
  busy: boolean;
  // live theme list — /themes cycles whatever themes.json currently has
  themeIds?: string[];
  // variations the active theme provides — /scheme no-ops when locked to one
  activeModes?: ("dark" | "light")[];
  // Ctrl(+Shift+)Tab session cycling — dir follows sidebar recency order
  onCycleSessions?: (dir: 1 | -1) => void;
  // Ctrl+W close active session — ChatPage owns empty-vs-confirm logic
  onCloseSession?: () => void;
  // Ctrl+` toggles the terminal dock
  onToggleTerm?: () => void;
  // Ctrl+B toggles the session sidebar (VS Code parity, global)
  onToggleSidebar?: () => void;
  // Ctrl+O opens the workspace picker (same as Browse button)
  onOpenWorkspace?: () => void;
  // Ctrl+Shift+N opens a new window (second instance)
  onNewInstance?: () => void;
}) {
  // double-Escape stop gesture — armed by the first free Escape (the stop
  // button surfaces the window as a draining countdown ring), landed by the
  // second. clearStopArmed also goes to the stop button so a manual click
  // dismisses the ring instantly
  const [stopArmed, setStopArmed] = useState(false);
  const armTimer = useRef<number | undefined>(undefined);
  const clearStopArmed = useCallback(() => {
    window.clearTimeout(armTimer.current);
    setStopArmed(false);
  }, []);
  // keep no stale timer across unmount
  useEffect(() => () => window.clearTimeout(armTimer.current), []);
  // follow links from chat content in the embedded browser — capture phase,
  // because react-markdown anchors aren't ours to attach handlers to
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!/^(https?:)?\/\//i.test(href)) return;
      e.preventDefault();
      openBrowser(/^https?:\/\//i.test(href) ? href : `https:${href}`);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [openBrowser]);

  // Ctrl+wheel / Ctrl +/-/0 drive the uiScale setting through the shared
  // zoom presets — preventDefault stays so WebView2's own zoom never kicks in
  useEffect(() => {
    // one preset step per ~50px of accumulated wheel delta — trackpads emit
    // many small deltas, mouse notches one big one
    let acc = 0;
    const stepZoom = (dir: 1 | -1) => {
      const i = UI_SCALES.indexOf(settings.uiScale);
      const cur = i === -1 ? UI_SCALES.indexOf(1) : i;
      const next = UI_SCALES[Math.min(Math.max(cur + dir, 0), UI_SCALES.length - 1)];
      if (next !== settings.uiScale) update({ uiScale: next });
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) >= 50) {
        stepZoom(acc > 0 ? -1 : 1);
        acc = 0;
      }
    };
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      if (["=", "+", "-"].includes(e.key)) {
        e.preventDefault();
        stepZoom(e.key === "-" ? -1 : 1);
      } else if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        update({ uiScale: 1 });
      }
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
    };
  }, [settings.uiScale, update]);

  // double-Escape within four seconds aborts the running turn — the
  // keyboard twin of the stop button. The first free Escape arms the
  // gesture; the second lands it. An Escape hitting an open menu/dialog
  // belongs to that surface: the gesture disarms and the local handler
  // closes its thing (this listener still sees the keydown even when they
  // preventDefault). e.repeat is ignored so holding the key cannot
  // machine-gun aborts
  useEffect(() => {
    let last = 0;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      // Escape inside the terminal belongs to the shell (vim et al.)
      if ((e.target as HTMLElement)?.closest?.(".term-dock")) return;
      if (document.querySelector(OVERLAY_SEL)) {
        clearStopArmed();
        return;
      }
      if (!busy) return;
      const now = Date.now();
      if (now - last <= STOP_ARM_MS) {
        last = 0;
        clearStopArmed();
        abort();
      } else {
        last = now;
        setStopArmed(true);
        window.clearTimeout(armTimer.current);
        armTimer.current = window.setTimeout(clearStopArmed, STOP_ARM_MS);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, abort, clearStopArmed]);

  // the turn ended some other way → drop any pending arm
  useEffect(() => {
    if (!busy) clearStopArmed();
  }, [busy, clearStopArmed]);

  // suppress the raw browser right-click menu (desktop app, not a page)
  useEffect(() => {
    const ctx = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", ctx);
    return () => document.removeEventListener("contextmenu", ctx);
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

  // Ctrl+Tab next chat, Ctrl+Shift+Tab previous — full loop at both ends.
  // preventDefault keeps WebView2 from treating Tab as focus traversal
  useEffect(() => {
    if (!onCycleSessions) return;
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.key !== "Tab") return;
      e.preventDefault();
      playSound("click");
      onCycleSessions(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCycleSessions]);

  // Ctrl+W closes the active session
  useEffect(() => {
    if (!onCloseSession) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "w"
      ) {
        e.preventDefault();
        onCloseSession();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCloseSession]);

  // Ctrl+` toggles the terminal dock — e.code (physical backtick) so it
  // fires on layouts where the character needs Shift
  useEffect(() => {
    if (!onToggleTerm) return;
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.code !== "Backquote") return;
      e.preventDefault();
      playSound("click");
      onToggleTerm();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onToggleTerm]);

  // Ctrl+B toggles the session sidebar — VS Code parity, global (no terminal
  // guard, works even when an editor/terminal has focus)
  useEffect(() => {
    if (!onToggleSidebar) return;
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      onToggleSidebar();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onToggleSidebar]);

  // Ctrl+O opens the workspace picker — exact same behavior as the Browse
  // button (pickWorkspace → applyWorkspace → reload), global like VS Code
  useEffect(() => {
    if (!onOpenWorkspace) return;
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() !== "o") return;
      e.preventDefault();
      onOpenWorkspace();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onOpenWorkspace]);

  // Ctrl+Shift+N opens a new window — in-app only, same as tray "Open new window"
  useEffect(() => {
    if (!onNewInstance) return;
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() !== "n") return;
      e.preventDefault();
      onNewInstance();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onNewInstance]);

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

  // slash-command UI handoffs (/themes /scheme)
  useEffect(() => {
    const themes = () => {
      const ids = themeIds ?? [];
      if (!ids.length) return;
      update({ theme: ids[(ids.indexOf(settings.theme) + 1) % ids.length] });
    };
    const scheme = () => {
      if (activeModes && activeModes.length < 2) return;
      update({ mode: settings.mode === "dark" ? "light" : "dark" });
    };
    window.addEventListener("oc:themes", themes);
    window.addEventListener("oc:scheme", scheme);
    return () => {
      window.removeEventListener("oc:themes", themes);
      window.removeEventListener("oc:scheme", scheme);
    };
  }, [settings.theme, settings.mode, update, themeIds, activeModes]);

  useEffect(() => {
    const collapse = () => update({ collapsed: !settings.collapsed });
    window.addEventListener("oc:diff", toggleDiff);
    window.addEventListener("oc:settings", openSettings);
    window.addEventListener("oc:collapse", collapse);
    return () => {
      window.removeEventListener("oc:diff", toggleDiff);
      window.removeEventListener("oc:settings", openSettings);
      window.removeEventListener("oc:collapse", collapse);
    };
  }, [settings.collapsed, update, toggleDiff, openSettings]);

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

  return { stopArmed, clearStopArmed };
}
