import { useEffect } from "react";
import "../styles/dialog.css";

// centered square glass dialog — shared shell for command output overlays
export default function Dialog({
  title,
  onClose,
  wide,
  top,
  stage,
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  top?: boolean;
  // extra-large centered variant for content-heavy views
  stage?: boolean;
  // optional controls rendered in the header before the close button
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className={`dlg-scrim${top ? " dlg-top" : ""}`} onClick={onClose}>
      <div
        className={`dlg-panel${wide ? " dlg-wide" : ""}${stage ? " dlg-stage" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="dlg-head">
          <span>{title}</span>
          <div className="dlg-head-end">
            {actions}
            <button className="icon-btn dlg-close" data-tip="Close" onClick={onClose}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
        </div>
        <div className="dlg-body">{children}</div>
      </div>
    </div>
  );
}
