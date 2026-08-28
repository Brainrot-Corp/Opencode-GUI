import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings } from "./useSettings";
import { playSound } from "../lib/sounds";
import { UI_SCALES } from "../lib/uiScale";
import { matchesEvent } from "../lib/hotkeys";

// surfaces that own a single Escape (menus, dialogs, popups) — while any of
// them is open the double-Escape stop gesture stands down entirely and the
// keypress goes to whatever handles closing that surface. NOTE: only pick
// classes that are MOUNTED only while open — .drawer-scrim for one stays in
// the DOM forever and just toggles its .open class
const OVERLAY_SEL =
  ".cmd-menu, .model-menu, .ctx-menu, .dlg-scrim, .drawer-scrim.open, .permission-bar, .comp-find, .fe-find, .chat-find, .ft-find";
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
  onToggleSettings,
  onOpenWorkspace,
  onNewInstance,
  onNewSession,
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
  // Ctrl+, toggles settings (rebindable)
  onToggleSettings?: () => void;
  // Ctrl+O opens the workspace picker (same as Browse button)
  onOpenWorkspace?: () => void;
  // Ctrl+Shift+N opens a new window (second instance)
  onNewInstance?: () => void;
  // Ctrl+N creates a new session — app-wide like Ctrl+B/O/W
  onNewSession?: () => void;
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
    const hk = settings.hotkeys;
    const key = (e: KeyboardEvent) => {
      if (hk.zoomIn && matchesEvent(e, hk.zoomIn)) {
        e.preventDefault();
        stepZoom(1);
        return;
      }
      if (hk.zoomOut && matchesEvent(e, hk.zoomOut)) {
        e.preventDefault();
        stepZoom(-1);
        return;
      }
      if (hk.zoomReset && matchesEvent(e, hk.zoomReset)) {
        e.preventDefault();
        update({ uiScale: 1 });
        return;
      }
      // keep legacy hard check as fallback when unbound? no — unbound means disabled
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
    };
  }, [settings.uiScale, settings.hotkeys.zoomIn, settings.hotkeys.zoomOut, settings.hotkeys.zoomReset, update]);

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
  // exception: xterm needs its native menu for copy/paste (Ctrl+Shift+C/V fallback)
  useEffect(() => {
    const ctx = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.(".xterm, .term-mount, .term-body")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", ctx);
    return () => document.removeEventListener("contextmenu", ctx);
  }, []);

  // Pin on top — rebindable (default Ctrl+P)
  useEffect(() => {
    const binding = settings.hotkeys.pinOnTop;
    if (!binding) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, binding)) return;
      e.preventDefault();
      playSound("click");
      update({ alwaysOnTop: !settings.alwaysOnTop });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settings.alwaysOnTop, settings.hotkeys.pinOnTop, update]);

  // Cycle sessions — rebindable (default Ctrl+Tab / Ctrl+Shift+Tab)
  useEffect(() => {
    if (!onCycleSessions) return;
    const nextB = settings.hotkeys.cycleNext;
    const prevB = settings.hotkeys.cyclePrev;
    if (!nextB && !prevB) return;
    const key = (e: KeyboardEvent) => {
      if (nextB && matchesEvent(e, nextB)) {
        e.preventDefault();
        playSound("click");
        onCycleSessions(1);
        return;
      }
      if (prevB && matchesEvent(e, prevB)) {
        e.preventDefault();
        playSound("click");
        onCycleSessions(-1);
        return;
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCycleSessions, settings.hotkeys.cycleNext, settings.hotkeys.cyclePrev]);

  // Close session — rebindable (default Ctrl+W)
  useEffect(() => {
    if (!onCloseSession) return;
    const b = settings.hotkeys.closeSession;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      onCloseSession();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCloseSession, settings.hotkeys.closeSession]);

  // Toggle terminal — rebindable (default Ctrl+`)
  useEffect(() => {
    if (!onToggleTerm) return;
    const b = settings.hotkeys.toggleTerm;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      playSound("click");
      onToggleTerm();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onToggleTerm, settings.hotkeys.toggleTerm]);

  // Toggle sidebar — rebindable (default Ctrl+B)
  useEffect(() => {
    if (!onToggleSidebar) return;
    const b = settings.hotkeys.toggleSidebar;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      onToggleSidebar();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onToggleSidebar, settings.hotkeys.toggleSidebar]);

  // Toggle settings — rebindable (default Ctrl+,)
  useEffect(() => {
    if (!onToggleSettings) return;
    const b = settings.hotkeys.openSettings;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      onToggleSettings();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onToggleSettings, settings.hotkeys.openSettings]);

  // Open workspace — rebindable (default Ctrl+O)
  useEffect(() => {
    if (!onOpenWorkspace) return;
    const b = settings.hotkeys.openWorkspace;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      onOpenWorkspace();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onOpenWorkspace, settings.hotkeys.openWorkspace]);

  // New window — rebindable (default Ctrl+Shift+N)
  useEffect(() => {
    if (!onNewInstance) return;
    const b = settings.hotkeys.newWindow;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      onNewInstance();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onNewInstance, settings.hotkeys.newWindow]);

  // New session — rebindable (default Ctrl+N)
  useEffect(() => {
    if (!onNewSession) return;
    const b = settings.hotkeys.newSession;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      playSound("click");
      onNewSession();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onNewSession, settings.hotkeys.newSession]);

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

  // Alt+Tab / Alt+Space returning leaves WebView2 without DOM focus: window
  // has OS focus but document.hasFocus() is false or activeElement is body, so
  // every window `keydown` keybind (Ctrl+B etc.) stops firing until a click.
  // Rescue: remember the last focused element on blur, then on any window
  // re-activation (DOM focus, Tauri focus, visibility show) re-assert it.
  useEffect(() => {
    const savedRef = { current: null as HTMLElement | null };
    const saveFocus = () => {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && document.contains(ae)) {
        // don't remember transient menu items that will be unmounted
        if (ae.closest(".ctx-menu, .cmd-menu, .model-menu")) return;
        savedRef.current = ae;
      }
    };

    const rescueFocus = () => {
      // let the OS focus settle before poking the DOM (Alt+Tab posts focus async)
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          // visible dialog/drawer/menu owns focus — don't steal to composer
          const overlay = document.querySelector(
            ".dlg-scrim, .drawer-scrim.open, .ctx-menu, .cmd-menu, .model-menu",
          ) as HTMLElement | null;
          if (overlay) {
            if (!overlay.contains(document.activeElement)) {
              const focusable = overlay.querySelector(
                "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])",
              ) as HTMLElement | null;
              // ensure DOM can receive keydowns even if overlay has no focusable
              window.focus();
              focusable?.focus({ preventScroll: true } as any);
              if (document.hasFocus()) return;
            } else {
              // re-assert existing overlay focus so WebView2 re-routes keys
              (document.activeElement as HTMLElement | null)?.focus?.({ preventScroll: true } as any);
              window.focus();
              return;
            }
          }

          const ae = document.activeElement as HTMLElement | null;
          const saved = savedRef.current;

          // try saved element first (usually the composer textarea)
          if (saved && document.contains(saved) && saved !== document.body) {
            window.focus();
            try {
              saved.focus({ preventScroll: true } as any);
            } catch {}
            if (document.hasFocus() && document.activeElement === saved) return;
            // xterm / non-input saved targets may not take DOM focus — fall through
          }

          // current element still there but WebView2 lost its route — re-focus it
          if (ae && ae !== document.body && document.contains(ae)) {
            window.focus();
            try {
              ae.focus({ preventScroll: true } as any);
            } catch {}
            if (document.hasFocus()) return;
          }

          // fallback: composer → file editor → body. Any focused element inside
          // the document re-enables window `keydown` bubbling for global shortcuts.
          const fallback =
            (document.querySelector(".composer textarea") as HTMLElement | null) ||
            (document.querySelector(".fe-ta") as HTMLElement | null) ||
            (document.querySelector(".term-mount") as HTMLElement | null) ||
            document.body;
          window.focus();
          try {
            fallback?.focus({ preventScroll: true } as any);
          } catch {}
          // last resort: ensure body is focusable so window keydowns fire
          if (!document.hasFocus() && document.body) {
            if (!document.body.hasAttribute("tabindex")) document.body.setAttribute("tabindex", "-1");
            document.body.focus({ preventScroll: true } as any);
            window.focus();
          }
        }, 20);
      });
    };

    // DOM blur saves, DOM focus rescues (Alt+Tab without hide)
    const onBlur = () => saveFocus();
    const onFocus = () => rescueFocus();
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    // Tauri window focus (more reliable than DOM after hide/show) + visibility show (Alt+Space / tray)
    // + explicit Rust focus://restore (emitted from unpoison_input and WindowEvent::Focused)
    // — the latter is the only signal that reliably fires after Alt+Tab when
    // WebView2 swallows DOM focus/blur.
    let unWin: (() => void) | undefined;
    let unVis: (() => void) | undefined;
    let unRestore: (() => void) | undefined;
    // dynamic import avoids hard failure if window api missing in tests
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        try {
          const win = getCurrentWindow();
          win.onFocusChanged(({ payload: focused }) => {
            if (focused) rescueFocus();
            else saveFocus();
          }).then((f) => {
            unWin = f;
          }).catch(() => {});
        } catch {}
      })
      .catch(() => {});
    void listen<boolean>("visibility://changed", (e) => {
      if (e.payload) rescueFocus();
      else saveFocus();
    })
      .then((f) => {
        unVis = f;
      })
      .catch(() => {});
    void listen("focus://restore", () => rescueFocus())
      .then((f) => {
        unRestore = f;
      })
      .catch(() => {});

    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      unWin?.();
      unVis?.();
      unRestore?.();
    };
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
