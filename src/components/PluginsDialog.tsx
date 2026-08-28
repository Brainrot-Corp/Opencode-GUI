import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Dialog from "./Dialog";
import PluginSettingsDialog from "./PluginSettingsDialog";
import type { LoadedPlugin } from "../lib/plugins";
import { isNewer } from "../lib/plugins";
import type { AppSettings } from "../hooks/useSettings";
import {
  fetchPluginFiles,
  pluginRawUrl,
  normalizePluginUrl,
  dirFromUrl,
  type PluginCatalogEntry,
} from "../lib/pluginsCatalog";
import "../styles/dialog.css";
import "../styles/plugins.css";

export default function PluginsDialog({
  open,
  onClose,
  plugins,
  onToggle,
  onRemoved,
  settings,
  updatePlugin,
  catalog,
  catalogLoading,
  catalogError,
  onRefreshCatalog,
  autoUpdateEnabled,
  onToggleAutoUpdate,
}: {
  open: boolean;
  onClose: () => void;
  plugins: LoadedPlugin[];
  onToggle: (id: string, enabled: boolean) => void;
  onRemoved: (id: string) => void;
  settings?: AppSettings;
  updatePlugin?: (id: string, patch: Record<string, unknown>) => void;
  catalog?: PluginCatalogEntry[] | null;
  catalogLoading?: boolean;
  catalogError?: string;
  onRefreshCatalog?: (force?: boolean) => Promise<unknown>;
  autoUpdateEnabled?: boolean;
  onToggleAutoUpdate?: (v: boolean) => void;
}) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState("");

  // catalog now owned by ChatPage (single source) — dialog is stateless for it
  const catLoading = !!catalogLoading;
  const catErr = catalogError ?? "";
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  // url install
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlErr, setUrlErr] = useState("");
  const [settingsId, setSettingsId] = useState<string | null>(null);

  function armConfirm(key: string) {
    setConfirmKey(key);
    setTimeout(() => setConfirmKey((v) => (v === key ? null : v)), 4000);
  }

  async function handleDelete(p: LoadedPlugin) {
    const key = `${p.dir}:delete`;
    if (confirmKey !== key) {
      armConfirm(key);
      return;
    }
    setRemoving(p.dir);
    setErr("");
    try {
      const isDiscord = p.id === "discord-rich-presence" || p.dir === "discord-rich-presence";
      if (isDiscord) {
        try {
          const w = window as unknown as Record<string, unknown>;
          const stop = w["__discordStop"] as (() => void) | undefined;
          if (typeof stop === "function") stop();
        } catch {}
        invoke("discord_clear").catch(() => {});
        invoke("discord_close").catch(() => {});
      }
      await invoke("plugin_remove", { dir: p.dir });
      onRemoved(p.id);
      if (p.id !== p.dir) onRemoved(p.dir);
      setConfirmKey(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  }

  async function handleReinstall(p: LoadedPlugin) {
    const key = `${p.dir}:reinstall`;
    if (confirmKey !== key) {
      armConfirm(key);
      return;
    }
    setConfirmKey(null);
    const entry = catalog?.find((c) => c.id === p.id || c.id === p.dir);
    if (!entry) {
      setErr(`No catalog entry for ${p.id} — try Refresh or Install from URL`);
      return;
    }
    await handleInstall(entry);
  }

  function refreshCatalog(force = false) {
    void onRefreshCatalog?.(force)?.catch(() => {});
  }

  useEffect(() => {
    if (!open) setSettingsId(null);
  }, [open]);

  async function handleInstall(entry: PluginCatalogEntry) {
    setInstalling(entry.id);
    setErr("");
    try {
      const base = pluginRawUrl(entry.id, "").replace(/\/$/, "");
      // use shared fetch helper for consistency (handles css optional)
      const { manifest, main, css } = await fetchPluginFiles(base);
      const dir = entry.id;
      await invoke("plugin_install_files", { dir, manifest, main, css });
      // watcher will reload; no need to manually refresh plugins prop
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }

  async function handleUrlInstall() {
    const raw = url.trim();
    if (!raw) return;
    if (!raw.startsWith("https://")) {
      setUrlErr("Only https:// URLs are allowed");
      return;
    }
    const base = normalizePluginUrl(raw);
    if (!base.startsWith("https://")) {
      setUrlErr("Invalid URL");
      return;
    }
    setUrlBusy(true);
    setUrlErr("");
    setErr("");
    try {
      const { manifest, main, css } = await fetchPluginFiles(base);
      let dir = dirFromUrl(base);
      // prefer id from manifest if valid
      try {
        const m = JSON.parse(manifest) as Record<string, unknown>;
        if (typeof m.id === "string" && m.id && /^[a-z0-9][a-z0-9\-_]+$/i.test(m.id)) dir = m.id;
      } catch {}
      // sanitize dir like Rust does
      dir = dir.trim();
      if (!dir || dir.includes("/") || dir.includes("\\") || dir.includes("..") || dir.includes(":")) {
        throw new Error("Invalid plugin id from URL");
      }
      await invoke("plugin_install_files", { dir, manifest, main, css });
      setUrl("");
    } catch (e) {
      setUrlErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUrlBusy(false);
    }
  }

  const getInstalled = (id: string) => plugins.find((p) => p.id === id || p.dir === id) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = (catalog ?? []).filter((e) => {
    if (getInstalled(e.id)) return false;
    if (!q) return true;
    return e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q);
  });
  const availableCount = (catalog ?? []).filter((c) => !getInstalled(c.id)).length;
  // version-aware update check — catalog version newer than installed
  const hasUpdate = (id: string) => {
    const inst = getInstalled(id);
    const cat = catalog?.find((c) => c.id === id);
    if (!inst || !cat?.version) return false;
    return isNewer(inst.version, cat.version);
  };
  const updateCount = catalog ? plugins.filter((p) => hasUpdate(p.id)).length : 0;

  async function handleUpdate(p: LoadedPlugin) {
    const entry = catalog?.find((c) => c.id === p.id || c.id === p.dir);
    if (!entry) {
      setErr(`No catalog entry for ${p.id} — try Refresh or Install from URL`);
      return;
    }
    await handleInstall(entry);
  }

  if (!open) return null;

  const activeSettingsPlugin = settingsId ? plugins.find((x) => x.id === settingsId || x.dir === settingsId) ?? null : null;

  return (
    <>
      <Dialog
      title="Plugins"
      onClose={onClose}
      top
      wide
      actions={
        <button
          type="button"
          className="reset-btn"
          data-tip="Open plugin folder"
          onClick={() => invoke("reveal_plugins_dir").catch(() => {})}
        >
          <i className="fa-solid fa-folder-open" />
          Open folder
        </button>
      }
    >
      <div className="dlg-tabs">
        {(["installed", "browse"] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={`dlg-tab${tab === id ? " on" : ""}`}
            onClick={() => setTab(id)}
          >
            {id === "installed" ? `Installed (${plugins.length})` : "Browse"}
          </button>
        ))}
      </div>

      {err && <div className="voice-err">{err}</div>}

      {tab === "installed" ? (
        <>
          <div className="browse-search" style={{ padding: "2px 0 0" }}>
            <div className="model-search-wrap">
              <i className={`fa-solid ${catLoading ? "fa-spinner fa-spin" : "fa-arrows-rotate"}`} style={{ color: updateCount ? "var(--accent)" : undefined }} />
              <span className="mono-hint" style={{ flex: 1 }}>
                {catLoading ? "Checking for updates…" : updateCount ? `${updateCount} update${updateCount === 1 ? "" : "s"} available` : catalog ? "All plugins up to date" : "Checking catalog…"}
              </span>
              {updateCount > 0 && plugins.length > 0 && (
                <button
                  type="button"
                  className="reset-btn"
                  disabled={!!installing || catLoading}
                  onClick={async () => {
                    for (const p of plugins.filter((x) => hasUpdate(x.id))) await handleUpdate(p);
                  }}
                >
                  <i className="fa-solid fa-download" /> Update all
                </button>
              )}
              <label className="mono-hint" data-tip="When on, plugins update automatically as soon as a newer version is found" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={!!autoUpdateEnabled} onChange={(e) => onToggleAutoUpdate?.(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
                Auto-update
              </label>
              <button
                type="button"
                className="reset-btn"
                data-tip="Force refresh catalog (bypass 12h cache)"
                disabled={catLoading}
                onClick={() => refreshCatalog(true)}
              >
                <i className={`fa-solid ${catLoading ? "fa-spinner fa-spin" : "fa-arrows-rotate"}`} />
                Refresh
              </button>
            </div>
          </div>
          {plugins.length === 0 ? (
            <div className="plugins-empty">
              <i className="fa-solid fa-puzzle-piece plugins-empty-icon" />
              <div className="plugins-empty-title">No plugins installed</div>
              <div className="mono-hint">
                Drop a folder with <code>plugin.json</code> + <code>main.js</code> into the plugins folder or browse the catalog.
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="reset-btn"
                  onClick={() => invoke("reveal_plugins_dir").catch(() => {})}
                >
                  <i className="fa-solid fa-folder-open" />
                  Open plugin folder
                </button>
                <button type="button" className="reset-btn" onClick={() => setTab("browse")}>
                  <i className="fa-solid fa-globe" />
                  Browse catalog
                </button>
              </div>
            </div>
          ) : (
            <>
              {catalog != null && !catalog.length && !catLoading ? <div className="voice-err">No plugins found — check connection and try refresh</div> : catErr ? <div className="voice-err">{catErr}</div> : null}
              <div className="plugins-list">
                {plugins.map((p) => {
                  const enabled = !p.disabled;
                  const isRemoving = removing === p.dir;
                  const needsUpdate = hasUpdate(p.id);
                  const catEntry = catalog?.find((c) => c.id === p.id || c.id === p.dir);
                  const busy = installing === p.id || installing === p.dir;
                  const reinstallKey = `${p.dir}:reinstall`;
                  const deleteKey = `${p.dir}:delete`;
                  const isReinstallArmed = confirmKey === reinstallKey;
                  const isDeleteArmed = confirmKey === deleteKey;
                  return (
                    <div key={p.dir} className={`plugin-row${p.disabled ? " disabled" : ""}`}>
                      <div className="plugin-info">
                        <div className="plugin-name">
                          <i className={`fa-solid fa-puzzle-piece plugin-icon${p.disabled ? " dim" : ""}`} />
                          <span>{p.name}</span>
                          {p.version && <span className="plugin-badge">{p.version}</span>}
                          {needsUpdate && catEntry?.version && <span className="plugin-badge" style={{ borderColor: "color-mix(in srgb, var(--accent) 45%, var(--line))", color: "var(--accent-bright)" }}>→ {catEntry.version}</span>}
                          {p.disabled && <span className="plugin-badge">disabled</span>}
                          {needsUpdate && <span className="plugin-badge" style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)", borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)", color: "var(--accent-bright)" }}>update</span>}
                        </div>
                        <div className="mono-hint plugin-id">
                          {p.id}
                          {p.id !== p.dir ? ` · ${p.dir}` : ""}
                          {p.description ? ` · ${p.description.slice(0, 80)}` : ""}
                        </div>
                        {p.error && <div className="voice-err plugin-err">{p.error}</div>}
                      </div>
                      <div className="plugin-actions">
                        {needsUpdate && (
                          <button
                            type="button"
                            className="reset-btn"
                            disabled={busy || isRemoving}
                            data-tip={`Update ${p.id} ${p.version ?? ""} → ${catEntry?.version ?? ""}`}
                            onClick={() => void handleUpdate(p)}
                          >
                            <i className={`fa-solid ${busy ? "fa-spinner fa-spin" : "fa-arrows-rotate"}`} />
                            {busy ? "Updating…" : "Update"}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`toggle${enabled ? " on" : ""}`}
                          aria-pressed={enabled}
                          data-tip={enabled ? "Disable plugin" : "Enable plugin"}
                          disabled={isRemoving || busy}
                          onClick={() => onToggle(p.id, !enabled)}
                        >
                          <span className="knob" />
                        </button>
                        {p.disabled ? (
                          <button
                            type="button"
                            className="reset-btn"
                            data-tip="Enable to configure"
                            disabled
                            aria-disabled="true"
                          >
                            <i className="fa-solid fa-gear" />
                            Settings
                          </button>
                        ) : p.ext?.Settings ? (
                          <button
                            type="button"
                            className="reset-btn"
                            data-tip={`${p.name} settings`}
                            disabled={isRemoving || busy}
                            onClick={() => setSettingsId(p.id)}
                          >
                            <i className="fa-solid fa-gear" />
                            Settings
                          </button>
                        ) : null}
                        <div className="split-btn" aria-label="Reinstall or delete">
                          <button
                            type="button"
                            className={`split-half reinstall${isReinstallArmed ? " armed" : ""}`}
                            data-tip={isReinstallArmed ? "Click again to confirm reinstall" : "Reinstall from catalog"}
                            disabled={isRemoving || busy}
                            onClick={() => void handleReinstall(p)}
                          >
                            <i className={`fa-solid ${isReinstallArmed ? "fa-triangle-exclamation" : busy ? "fa-spinner fa-spin" : "fa-rotate"}`} />
                            <span className="split-label">{isReinstallArmed ? "Confirm" : busy ? "…" : "Reinstall"}</span>
                          </button>
                          <button
                            type="button"
                            className={`split-half delete${isDeleteArmed ? " armed" : ""}`}
                            data-tip={isDeleteArmed ? "Click again to confirm delete" : "Delete plugin folder"}
                            disabled={isRemoving || busy}
                            onClick={() => void handleDelete(p)}
                          >
                            <i className={`fa-solid ${isDeleteArmed ? "fa-triangle-exclamation" : "fa-trash-can"}`} />
                            <span className="split-label">{isDeleteArmed ? "Confirm" : isRemoving ? "…" : "Delete"}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {catErr && <div className="voice-err">{catErr}</div>}
          {urlErr && <div className="voice-err">{urlErr}</div>}

          <div className="setting-row" style={{ padding: "4px 0" }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <i className="fa-solid fa-link setting-icon" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="setting-name">Install from URL</div>
                <div className="setting-desc">Paste a GitHub folder or raw URL to plugin.json / main.js — e.g. https://github.com/Brainrot-Corp/Opencode-GUI/tree/main/default_plugins/tuya-lights-control</div>
              </div>
            </div>
          </div>
          <div className="browse-search" style={{ padding: "2px 0 0" }}>
            <div className="model-search-wrap">
              <i className="fa-solid fa-link" />
              <input
                className="model-search"
                type="text"
                placeholder="https://raw.githubusercontent.com/.../plugin.json"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleUrlInstall();
                }}
              />
              <button
                type="button"
                className="reset-btn"
                disabled={urlBusy || !url.trim()}
                onClick={() => void handleUrlInstall()}
              >
                <i className={`fa-solid ${urlBusy ? "fa-spinner fa-spin" : "fa-download"}`} />
                {urlBusy ? "Installing…" : "Install"}
              </button>
            </div>
          </div>

          <div className="browse-search" style={{ padding: "1px 0 1px" }}>
            <div className="model-search-wrap">
              <i className="fa-solid fa-magnifying-glass" />
              <input
                className="model-search"
                type="text"
                placeholder={`Filter ${catalog ? availableCount : "..."} available...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="reset-btn"
                data-tip="Force refresh catalog (bypass 12h cache)"
                disabled={catLoading}
                onClick={() => refreshCatalog(true)}
              >
                <i className={`fa-solid ${catLoading ? "fa-spinner fa-spin" : "fa-arrows-rotate"}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="browse-list">
            {catLoading && !catalog ? (
              <div className="model-empty">Loading catalog…</div>
            ) : filtered.length === 0 ? (
              <div className="model-empty">
                {catalog?.length === 0 ? "No plugins in catalog" : q ? "No plugins match" : "All available plugins are installed"}
              </div>
            ) : (
              filtered.map((e) => {
                const busy = installing === e.id;
                return (
                  <div key={e.id} className="plugin-row">
                    <div className="plugin-info">
                      <div className="plugin-name">
                        <i className="fa-solid fa-puzzle-piece plugin-icon" />
                        <span>{e.name}</span>
                        {e.version && <span className="plugin-badge">{e.version}</span>}
                      </div>
                      <div className="mono-hint plugin-id">{e.id}</div>
                      {e.description && <div className="mono-hint" style={{ fontSize: 11, lineHeight: 1.4 }}>{e.description}</div>}
                    </div>
                    <div className="plugin-actions">
                      <button
                        type="button"
                        className="reset-btn"
                        disabled={busy}
                        data-tip="Install from catalog"
                        onClick={() => void handleInstall(e)}
                      >
                        <i className={`fa-solid ${busy ? "fa-spinner fa-spin" : "fa-download"}`} />
                        {busy ? "Installing…" : "Install"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <p className="cmd-note mono-hint" style={{ padding: "4px 2px 0" }}>
            Catalog cached for 12h — <button type="button" className="linklike" onClick={() => refreshCatalog(true)} disabled={catLoading}>force refresh</button> to bypass. Sources from <code>github.com/Brainrot-Corp/Opencode-GUI/default_plugins</code>.
          </p>
        </>
      )}

      <p className="cmd-note mono-hint plugins-foot">
        Plugins live in <code>%USERPROFILE%\.config\.opencode-gui\plugins\</code> next to <code>themes.json</code>. Toggle disables without deleting — files stay on disk and hot-reload when you enable again. Delete removes the folder permanently.
      </p>
    </Dialog>
      {settings && updatePlugin && activeSettingsPlugin?.ext?.Settings && (
        <PluginSettingsDialog
          plugin={activeSettingsPlugin}
          settings={settings}
          updatePlugin={updatePlugin}
          onClose={() => setSettingsId(null)}
        />
      )}
    </>
  );
}
