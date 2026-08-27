// plugin state — loads once at boot, hot-reloads when the plugins folder
// changes (same watcher pattern as themes)
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadPlugins, setPluginDisabled, removeDisabledId, type LoadedPlugin } from "../lib/plugins";

export function usePlugins() {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [error, setError] = useState("");
  const prevRef = useRef<Map<string, LoadedPlugin>>(new Map());

  const clearDiscord = useCallback(() => {
    // stop JS interval leaked by disabled/removed discord plugin
    try {
      const w = window as unknown as Record<string, unknown>;
      const stop = w["__discordStop"] as (() => void) | undefined;
      if (typeof stop === "function") {
        stop();
        delete w["__discordStop"];
      }
    } catch {}
    invoke("discord_clear").catch(() => {});
    invoke("discord_close").catch(() => {});
  }, []);

  const reload = useCallback(async () => {
    const ps = await loadPlugins();
    // detect discord disabled/removed → clear RPC
    const prev = prevRef.current;
    const nextMap = new Map(ps.map((p) => [p.id, p] as const));
    const hadDiscord = prev.get("discord-rich-presence");
    const hasDiscord = nextMap.get("discord-rich-presence");
    const wasActive = hadDiscord ? !hadDiscord.disabled && !!hadDiscord.ext : false;
    const isActive = hasDiscord ? !hasDiscord.disabled && !!hasDiscord.ext : false;
    // also check dir key (fallback when manifest missing)
    const hadDiscordDir = prev.has("discord-rich-presence") || [...prev.values()].some((p) => p.dir === "discord-rich-presence");
    const hasDiscordDir = nextMap.has("discord-rich-presence") || ps.some((p) => p.dir === "discord-rich-presence");
    if ((wasActive && !isActive) || (hadDiscordDir && !hasDiscordDir)) {
      clearDiscord();
    }
    prevRef.current = nextMap;
    // also seed prev on first load from current ps (already done via comparison)
    setPlugins(ps);
    const errs = ps.filter((p) => p.error);
    setError(errs.length ? errs.map((p) => `${p.name}: ${p.error}`).join(" · ") : "");
  }, [clearDiscord]);

  useEffect(() => {
    let disposed = false;
    const doReload = () => {
      if (disposed) return;
      void reload();
    };
    doReload();
    let un: (() => void) | undefined;
    listen("plugins://changed", doReload).then((f) => {
      un = f;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [reload]);

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      // enabled=true → remove from disabled set; false → add
      if (!enabled && id === "discord-rich-presence") {
        clearDiscord();
      }
      setPluginDisabled(id, !enabled);
      await reload();
      if (!enabled && id === "discord-rich-presence") {
        // ensure cleared even if reload raced
        clearDiscord();
      }
    },
    [reload, clearDiscord],
  );

  const removeDisabled = useCallback((id: string) => {
    removeDisabledId(id);
  }, []);

  const exts = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.parse ? [p.ext] : []));
  const sections = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.Settings ? [p.ext] : []));
  const sidebarWidgets = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.Sidebar ? [p.ext] : []));
  const titlebarItems = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.Titlebar ? [p.ext] : []));
  const overlays = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.Overlay ? [p.ext] : []));

  return { plugins, exts, sections, sidebarWidgets, titlebarItems, overlays, error, reload, toggleEnabled, removeDisabled };
}
