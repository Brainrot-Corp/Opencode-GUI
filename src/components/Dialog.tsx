import { useEffect, useRef } from "react";
import "../styles/dialog.css";

// centered square glass dialog — shared shell for command output overlays
export default function Dialog({
  title,
  onClose,
  wide,
  top,
  stage,
  confirm,
  actions,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  top?: boolean;
  // extra-large centered variant for content-heavy views
  stage?: boolean;
  // two-step close: tints the X red and asks for a second click
  confirm?: boolean;
  // optional controls rendered in the header before the close button
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  // scrim click closes — but a text-selection drag that starts inside the
  // panel and releases outside (or vice versa) also fires click on the scrim
  // (nearest common ancestor), which used to slam the dialog shut mid-select.
  // Only honor presses that both start AND end on the scrim itself; a press
  // with no recorded mousedown (touch/keyboard) keeps the old behavior.
  const downT = useRef<EventTarget | null>(null);
  const upT = useRef<EventTarget | null>(null);
  const onScrimClick = (e: React.MouseEvent) => {
    const scrim = e.currentTarget;
    const down = downT.current;
    const up = upT.current;
    downT.current = null;
    upT.current = null;
    if (down && (down !== scrim || up !== scrim)) return;
    onClose();
  };

  return (
    <div
      className={`dlg-scrim${top ? " dlg-top" : ""}`}
      onMouseDown={(e) => {
        downT.current = e.target;
      }}
      onMouseUp={(e) => {
        upT.current = e.target;
      }}
      onClick={onScrimClick}
    >
      <div
        className={`dlg-panel${wide ? " dlg-wide" : ""}${stage ? " dlg-stage" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="dlg-head">
          <span>{title}</span>
          <div className="dlg-head-end">
            {actions}
            <button
              className={`icon-btn dlg-close${confirm ? " arm" : ""}`}
              data-tip={confirm ? "Click again to discard changes" : "Close"}
              onClick={onClose}
            >
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
        </div>
        <div className="dlg-body">{children}</div>
      </div>
    </div>
  );
}
