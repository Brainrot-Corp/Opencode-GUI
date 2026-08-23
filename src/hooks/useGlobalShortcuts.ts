import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { THEMES, type AppSettings } from "./useSettings";
import { playSound } from "../lib/sounds";

// window/document-level listeners ChatPage used to inline: embedded-browser
// link capture, WebView2 hotkey suppression, Ctrl+P pin, tray sounds,
// slash-command UI handoffs (oc:* events), and the generic button tick.
export function useGlobalShortcuts({
  settings,
  update,
  openBrowser,
  toggleDiff,
  openSettings,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  openBrowser: (url: string) => void;
  toggleDiff: () => void;
  openSettings: () => void;
}) {
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

  // slash-command UI handoffs (/themes /scheme)
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
    const thinking = () => update({ showThinking: !settings.showThinking });
    window.addEventListener("oc:diff", toggleDiff);
    window.addEventListener("oc:settings", openSettings);
    window.addEventListener("oc:thinking", thinking);
    return () => {
      window.removeEventListener("oc:diff", toggleDiff);
      window.removeEventListener("oc:settings", openSettings);
      window.removeEventListener("oc:thinking", thinking);
    };
  }, [settings.showThinking, update, toggleDiff, openSettings]);

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
}
