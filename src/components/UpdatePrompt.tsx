import { useState } from "react";
import Dialog from "./Dialog";
import type { UpdateInfo } from "../hooks/useUpdater";
import "../styles/update.css";

export default function UpdatePrompt({
  info,
  curVer,
  busy,
  downloading,
  err,
  onUpdate,
  onDismiss,
}: {
  info: UpdateInfo;
  curVer: string;
  busy: boolean;
  downloading: boolean;
  err: string;
  onUpdate: () => void;
  onDismiss: (disable: boolean) => void;
}) {
  const [disableChecked, setDisableChecked] = useState(false);

  return (
    <Dialog title={`Update available — v${info.version}`} onClose={() => onDismiss(disableChecked)} top>
      <div className="upd-body">
        <div className="upd-hero">
          <span className="upd-hero-icon">
            <i className="fa-solid fa-arrows-rotate" />
          </span>
          <p>
            A new version is available.
            {curVer && (
              <>
                {" "}
                <span className="mono-hint">v{curVer}</span> → <span className="mono-hint">v{info.version}</span>
              </>
            )}
          </p>
          {info.notes && <p className="upd-notes">{info.notes.replace(/\s+/g, " ").slice(0, 280)}</p>}
          {err && <div className="voice-err">{err}</div>}
          {busy && !info && <div className="mono-hint">Checking for releases…</div>}
        </div>

        <label className="upd-disable-row">
          <input
            type="checkbox"
            checked={disableChecked}
            onChange={(e) => setDisableChecked(e.target.checked)}
          />
          <span>Don't show update notifications again</span>
        </label>

        <div className="upd-actions">
          <button type="button" className="reset-btn" onClick={() => onDismiss(disableChecked)}>
            <i className="fa-solid fa-xmark" />
            Dismiss
          </button>
          <button
            type="button"
            className="reset-btn upd-primary"
            disabled={downloading}
            onClick={onUpdate}
          >
            <i className={`fa-solid ${downloading ? "fa-spinner fa-spin" : "fa-download"}`} />
            {downloading ? "Downloading…" : "Update & restart"}
          </button>
        </div>
        <div className="mono-hint upd-hint">You can always check manually in Settings → Updates.</div>
      </div>
    </Dialog>
  );
}
