import { useEffect } from "react";
import "../styles/dialog.css";

// centered square glass dialog — shared shell for command output overlays
export default function Dialog({
  title,
  onClose,
  wide,
  top,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  // layer above the settings drawer (drawer z-65, dialogs default z-30)
  top?: boolean;
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
        className={`dlg-panel${wide ? " dlg-wide" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="dlg-head">
          <span>{title}</span>
          <button className="icon-btn dlg-close" data-tip="Close" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="dlg-body">{children}</div>
      </div>
    </div>
  );
}
