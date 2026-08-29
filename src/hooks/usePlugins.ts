// plugin state — loads once at boot, hot-reloads when the plugins folder
// changes (same watcher pattern as themes). Disable/enable is incremental
// so other plugins aren't re-imported (preserves their state/hooks).
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  loadPlugins,
  setPluginDisabled,
  removeDisabledId,
  enablePlugin,
  unloadPluginResources,
  syncPluginsIncremental,
  syncPluginVocabAndSlash,
  type LoadedPlugin,
} from "../lib/plugins";

export function usePlugins() {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(t);
  }, [error]);
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
    // initial boot still does full load; subsequent watcher events are incremental
    // so disabling one plugin doesn't re-import the others.
    let ps: LoadedPlugin[];
    if (prevRef.current.size === 0) {
      ps = await loadPlugins();
    } else {
      // incremental: diff against current state, only (re)load changed dirs
      // need current plugins value — use prevRef + actual state via closure
      // For watcher, we don't have prev plugins array here, so fall back to
      // sync that reads prev from ref and rebuilds. To get actual array,
      // we keep a ref to latest plugins.
      ps = await syncPluginsIncremental([...prevRef.current.values()] as LoadedPlugin[]).catch(async () => await loadPlugins());
      // sync may miss disabled entries that are not in scan? It handles via byDir.
      // If sync returns same as prev (no change), it still updates lexicon.
    }
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
      // incremental toggle — don't reload other plugins (preserves their state)
      if (!enabled) {
        if (id === "discord-rich-presence") clearDiscord();
        setPluginDisabled(id, true);
        unloadPluginResources(id);
        setPlugins((prev) => {
          const next = prev.map((p) =>
            p.id === id || p.dir === id ? { ...p, disabled: true, ext: null, error: "" } : p,
          );
          syncPluginVocabAndSlash(next);
          prevRef.current = new Map(next.map((p) => [p.id, p] as const));
          const errs = next.filter((p) => p.error);
          setError(errs.length ? errs.map((p) => `${p.name}: ${p.error}`).join(" · ") : "");
          return next;
        });
        if (id === "discord-rich-presence") clearDiscord();
        return;
      }
      // enabling — load just that plugin
      setPluginDisabled(id, false);
      try {
        const p = await enablePlugin(id);
        if (p) {
          setPlugins((prev) => {
            const idx = prev.findIndex((x) => x.id === id || x.dir === id);
            let next: LoadedPlugin[];
            if (idx >= 0) {
              next = [...prev];
              next[idx] = p;
            } else {
              next = [...prev, p];
            }
            syncPluginVocabAndSlash(next);
            prevRef.current = new Map(next.map((x) => [x.id, x] as const));
            const errs = next.filter((x) => x.error);
            setError(errs.length ? errs.map((x) => `${x.name}: ${x.error}`).join(" · ") : "");
            return next;
          });
          return;
        }
      } catch (e) {
        // fall through to full reload on failure
      }
      await reload();
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
