import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Dialog from "./Dialog";
import type { LoadedPlugin } from "../lib/plugins";
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
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState("");

  if (!open) return null;

  async function handleDelete(p: LoadedPlugin) {
    if (confirmId !== p.dir) {
      setConfirmId(p.dir);
      setTimeout(() => setConfirmId((v) => (v === p.dir ? null : v)), 4000);
      return;
    }
    setRemoving(p.dir);
    setErr("");
    try {
      await invoke("plugin_remove", { dir: p.dir });
      onRemoved(p.id);
      // also clean dir-named disabled entry if present
      if (p.id !== p.dir) onRemoved(p.dir);
      setConfirmId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  }

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
      {err && <div className="voice-err">{err}</div>}

      {plugins.length === 0 ? (
        <div className="plugins-empty">
          <i className="fa-solid fa-puzzle-piece plugins-empty-icon" />
          <div className="plugins-empty-title">No plugins installed</div>
          <div className="mono-hint">Drop a folder with <code>plugin.json</code> + <code>main.js</code> into the plugins folder.</div>
          <button
            type="button"
            className="reset-btn"
            onClick={() => invoke("reveal_plugins_dir").catch(() => {})}
          >
            <i className="fa-solid fa-folder-open" />
            Open plugin folder
          </button>
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
                  <div className="mono-hint plugin-id">{p.id}{p.id !== p.dir ? ` · ${p.dir}` : ""}</div>
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

      <p className="cmd-note mono-hint plugins-foot">
        Plugins live in <code>%USERPROFILE%\.config\.opencode-gui\plugins\</code> next to <code>themes.json</code>. Toggle disables without deleting — files stay on disk and hot-reload when you enable again. Delete removes the folder permanently.
      </p>
    </Dialog>
  );
}
