// plugin state — loads once at boot, hot-reloads when the plugins folder
// changes (same watcher pattern as themes)
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadPlugins, setPluginDisabled, removeDisabledId, type LoadedPlugin } from "../lib/plugins";

export function usePlugins() {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const ps = await loadPlugins();
    setPlugins(ps);
    const errs = ps.filter((p) => p.error);
    setError(errs.length ? errs.map((p) => `${p.name}: ${p.error}`).join(" · ") : "");
  }, []);

  useEffect(() => {
    let disposed = false;
    const doReload = () =>
      loadPlugins().then((ps) => {
        if (disposed) return;
        setPlugins(ps);
        const errs = ps.filter((p) => p.error);
        setError(errs.length ? errs.map((p) => `${p.name}: ${p.error}`).join(" · ") : "");
      });
    doReload();
    let un: (() => void) | undefined;
    listen("plugins://changed", doReload).then((f) => {
      un = f;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      // enabled=true → remove from disabled set; false → add
      setPluginDisabled(id, !enabled);
      await reload();
    },
    [reload],
  );

  const removeDisabled = useCallback((id: string) => {
    removeDisabledId(id);
  }, []);

  const exts = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.parse ? [p.ext] : []));
  const sections = plugins.flatMap((p) => (p.disabled ? [] : p.ext?.Settings ? [p.ext] : []));

  return { plugins, exts, sections, error, reload, toggleEnabled, removeDisabled };
}
