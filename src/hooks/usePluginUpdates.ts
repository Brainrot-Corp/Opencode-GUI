import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadPluginsCatalog, fetchPluginFiles, pluginRawUrl, type PluginCatalogEntry } from "../lib/pluginsCatalog";
import { isNewer, getAutoUpdateEnabled, setAutoUpdateEnabled } from "../lib/plugins";

// plugin catalog prefetch + update detection + optional auto-update install.
// Catalog doubles as the PluginsDialog data source and the titlebar dot.
export function usePluginUpdates(plugins: { id: string; dir: string; version?: string; disabled: boolean }[]) {
  const [pluginCatalog, setPluginCatalog] = useState<PluginCatalogEntry[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState(() => getAutoUpdateEnabled());

  const refreshCatalog = useCallback(async (force = false) => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const entries = await loadPluginsCatalog(force);
      setPluginCatalog(entries);
      return entries;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCatalogError(msg);
      throw e;
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  // prefetch plugin catalog on launch — single source for titlebar dot + dialog (was duplicated in PluginsDialog)
  useEffect(() => {
    void refreshCatalog(false).catch(() => {});
  }, [refreshCatalog]);

  const hasPluginUpdate = useMemo(() => {
    if (!pluginCatalog || !pluginCatalog.length || !plugins.length) return false;
    const byId = new Map(pluginCatalog.map((c) => [c.id, c] as const));
    return plugins.some((p) => {
      const cat = byId.get(p.id) ?? byId.get(p.dir) ?? pluginCatalog.find((c) => c.id === p.id || c.id === p.dir);
      return isNewer(p.version, cat?.version);
    });
  }, [pluginCatalog, plugins]);

  const toggleAutoUpdate = useCallback((v: boolean) => {
    setAutoUpdateEnabled(v);
    setAutoUpdateEnabledState(v);
  }, []);

  // keep auto-update flag in sync across tabs / dialog-owned writes
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "oc.plugins.autoUpdate") setAutoUpdateEnabledState(e.newValue === "1");
    };
    const onCustom = (e: Event) => setAutoUpdateEnabledState(!!(e as CustomEvent).detail);
    window.addEventListener("storage", onStorage);
    window.addEventListener("oc:plugins-autoupdate", onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oc:plugins-autoupdate", onCustom as EventListener);
    };
  }, []);

  // auto-update: when enabled, install newer catalog versions immediately
  const autoUpdatingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoUpdateEnabled || !pluginCatalog?.length || !plugins.length || catalogLoading) return;
    const byId = new Map(pluginCatalog.map((c) => [c.id, c] as const));
    const toUpdate = plugins.filter((p) => {
      if (p.disabled) return false;
      const cat = byId.get(p.id) ?? byId.get(p.dir) ?? pluginCatalog.find((c) => c.id === p.id || c.id === p.dir);
      return isNewer(p.version, cat?.version);
    });
    if (!toUpdate.length) return;
    const pending = toUpdate.filter((p) => !autoUpdatingRef.current.has(p.id));
    if (!pending.length) return;
    void (async () => {
      for (const p of pending) {
        autoUpdatingRef.current.add(p.id);
        try {
          const entry = pluginCatalog.find((c) => c.id === p.id || c.id === p.dir);
          if (!entry) continue;
          const base = pluginRawUrl(entry.id, "").replace(/\/$/, "");
          const { manifest, main, css } = await fetchPluginFiles(base);
          await invoke("plugin_install_files", { dir: entry.id, manifest, main, css });
        } catch (e) {
          console.warn("[plugins auto-update] failed", p.id, e);
        } finally {
          autoUpdatingRef.current.delete(p.id);
        }
      }
    })();
  }, [autoUpdateEnabled, pluginCatalog, plugins, catalogLoading]);

  return { pluginCatalog, catalogLoading, catalogError, refreshCatalog, hasPluginUpdate, autoUpdateEnabled, toggleAutoUpdate };
}
