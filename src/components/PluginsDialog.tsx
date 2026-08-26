import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Dialog from "./Dialog";
import type { LoadedPlugin } from "../lib/plugins";
import {
  loadPluginsCatalog,
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
}: {
  open: boolean;
  onClose: () => void;
  plugins: LoadedPlugin[];
  onToggle: (id: string, enabled: boolean) => void;
  onRemoved: (id: string) => void;
}) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState("");

  // browse state
  const [catalog, setCatalog] = useState<PluginCatalogEntry[] | null>(null);
  const [catLoading, setCatLoading] = useState(false);
  const [catErr, setCatErr] = useState("");
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  // url install
  const [url, setUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlErr, setUrlErr] = useState("");

  async function handleDelete(p: LoadedPlugin) {
    if (confirmId !== p.dir) {
      setConfirmId(p.dir);
      setTimeout(() => setConfirmId((v) => (v === p.dir ? null : v)), 4000);
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
      setConfirmId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  }

  async function loadCatalog(force = false) {
    setCatLoading(true);
    setCatErr("");
    try {
      const entries = await loadPluginsCatalog(force);
      setCatalog(entries);
      if (!entries.length) setCatErr("No plugins found — check connection and try refresh");
    } catch (e) {
      setCatErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCatLoading(false);
    }
  }

  // lazy load on first browse open (like VoicesDialog)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!open) return;
    if (tab !== "browse") return;
    if (catalog !== null || catLoading) return;
    void loadCatalog(false);
  }, [open, tab, catalog, catLoading]);

  async function handleInstall(entry: PluginCatalogEntry) {
    setInstalling(entry.id);
    setErr("");
    setCatErr("");
    try {
      const base = pluginRawUrl(entry.id, "").replace(/\/$/, "");
      // use shared fetch helper for consistency (handles css optional)
      const { manifest, main, css } = await fetchPluginFiles(base);
      const dir = entry.id;
      await invoke("plugin_install_files", { dir, manifest, main, css });
      // watcher will reload; no need to manually refresh plugins prop
    } catch (e) {
      setCatErr(e instanceof Error ? e.message : String(e));
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

  const q = query.trim().toLowerCase();
  const filtered = (catalog ?? []).filter(
    (e) => !q || e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q),
  );
  const isInstalled = (id: string) => plugins.some((p) => p.id === id || p.dir === id);

  if (!open) return null;

  return (
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
            <div className="plugins-list">
              {plugins.map((p) => {
                const enabled = !p.disabled;
                const isConfirm = confirmId === p.dir;
                const isRemoving = removing === p.dir;
                return (
                  <div key={p.dir} className={`plugin-row${p.disabled ? " disabled" : ""}`}>
                    <div className="plugin-info">
                      <div className="plugin-name">
                        <i className={`fa-solid fa-puzzle-piece plugin-icon${p.disabled ? " dim" : ""}`} />
                        <span>{p.name}</span>
                        {p.disabled && <span className="plugin-badge">disabled</span>}
                      </div>
                      <div className="mono-hint plugin-id">
                        {p.id}
                        {p.id !== p.dir ? ` · ${p.dir}` : ""}
                      </div>
                      {p.error && <div className="voice-err plugin-err">{p.error}</div>}
                    </div>
                    <div className="plugin-actions">
                      <button
                        type="button"
                        className={`toggle${enabled ? " on" : ""}`}
                        aria-pressed={enabled}
                        data-tip={enabled ? "Disable plugin" : "Enable plugin"}
                        disabled={isRemoving}
                        onClick={() => onToggle(p.id, !enabled)}
                      >
                        <span className="knob" />
                      </button>
                      <button
                        type="button"
                        className={`reset-btn danger-btn${isConfirm ? " armed" : ""}`}
                        data-tip={isConfirm ? "Click again to confirm delete" : "Delete plugin folder"}
                        disabled={isRemoving}
                        onClick={() => void handleDelete(p)}
                      >
                        <i className={`fa-solid ${isConfirm ? "fa-triangle-exclamation" : "fa-trash-can"}`} />
                        {isConfirm ? "Confirm" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
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
                placeholder={`Filter ${catalog?.length ?? "..."} plugins...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="reset-btn"
                data-tip="Force refresh catalog (bypass 1-day cache)"
                disabled={catLoading}
                onClick={() => void loadCatalog(true)}
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
              <div className="model-empty">{catalog?.length === 0 ? "No plugins in catalog" : "No plugins match"}</div>
            ) : (
              filtered.map((e) => {
                const installed = isInstalled(e.id);
                const busy = installing === e.id;
                return (
                  <div key={e.id} className={`plugin-row${installed ? " disabled" : ""}`} style={{ opacity: installed ? 0.9 : 1, borderStyle: installed ? "solid" : undefined }}>
                    <div className="plugin-info">
                      <div className="plugin-name">
                        <i className="fa-solid fa-puzzle-piece plugin-icon" />
                        <span>{e.name}</span>
                        {e.version && <span className="plugin-badge">{e.version}</span>}
                        {installed && <span className="plugin-badge">installed</span>}
                      </div>
                      <div className="mono-hint plugin-id">{e.id}</div>
                      {e.description && <div className="mono-hint" style={{ fontSize: 11, lineHeight: 1.4 }}>{e.description}</div>}
                    </div>
                    <div className="plugin-actions">
                      <button
                        type="button"
                        className="reset-btn"
                        disabled={busy}
                        data-tip={installed ? "Reinstall / update from catalog" : "Install from catalog"}
                        onClick={() => void handleInstall(e)}
                      >
                        <i className={`fa-solid ${busy ? "fa-spinner fa-spin" : installed ? "fa-arrows-rotate" : "fa-download"}`} />
                        {busy ? "Installing…" : installed ? "Reinstall" : "Install"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <p className="cmd-note mono-hint" style={{ padding: "4px 2px 0" }}>
            Catalog cached for 1 day — <button type="button" className="linklike" onClick={() => void loadCatalog(true)} disabled={catLoading}>force refresh</button> to bypass. Sources from <code>github.com/Brainrot-Corp/Opencode-GUI/default_plugins</code>.
          </p>
        </>
      )}

      <p className="cmd-note mono-hint plugins-foot">
        Plugins live in <code>%USERPROFILE%\.config\.opencode-gui\plugins\</code> next to <code>themes.json</code>. Toggle disables without deleting — files stay on disk and hot-reload when you enable again. Delete removes the folder permanently.
      </p>
    </Dialog>
  );
}
