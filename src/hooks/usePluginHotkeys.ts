import { useEffect } from "react";
import type { LoadedPlugin } from "../lib/plugins";
import type { AppSettings } from "./useSettings";
import { matchesEvent, getPluginHotkeyBinding } from "../lib/hotkeys";

export function usePluginHotkeys({
  settings,
  plugins,
}: {
  settings: AppSettings;
  plugins: LoadedPlugin[];
}) {
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // app-wide per spec — plugins guard internally if they want input focus checks

      for (const p of plugins) {
        if (p.disabled || !p.ext?.hotkeys?.length) continue;
        for (const def of p.ext.hotkeys) {
          const binding = getPluginHotkeyBinding(settings.pluginHotkeys, p.id, {
            id: def.id,
            default: def.default,
            label: def.label,
          });
          if (!binding) continue;
          if (!matchesEvent(e, binding)) continue;
          e.preventDefault();
          // prefer per-def handle, then generic onHotkey
          const h = (def as any).handle as (() => void | Promise<void>) | undefined;
          if (typeof h === "function") {
            void Promise.resolve(h()).catch(() => {});
          } else if (typeof p.ext.onHotkey === "function") {
            void Promise.resolve(p.ext.onHotkey(def.id)).catch(() => {});
          } else {
            window.dispatchEvent(new CustomEvent("oc:plugin-hotkey", { detail: { pluginId: p.id, hotkeyId: def.id } }));
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onDown);
    return () => window.removeEventListener("keydown", onDown);
  }, [settings.pluginHotkeys, plugins]);
}
