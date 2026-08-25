// plugin state — loads once at boot, hot-reloads when the plugins folder
// changes (same watcher pattern as themes)
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadPlugins, type LoadedPlugin } from "../lib/plugins";

export function usePlugins() {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const reload = () =>
      loadPlugins().then((ps) => {
        if (disposed) return;
        setPlugins(ps);
        const errs = ps.filter((p) => p.error);
        setError(errs.length ? errs.map((p) => `${p.name}: ${p.error}`).join(" · ") : "");
      });
    reload();
    let un: (() => void) | undefined;
    listen("plugins://changed", reload).then((f) => {
      un = f;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const exts = plugins.flatMap((p) => (p.ext?.parse ? [p.ext] : []));
  const sections = plugins.flatMap((p) => (p.ext?.Settings ? [p.ext] : []));

  return { plugins, exts, sections, error };
}
