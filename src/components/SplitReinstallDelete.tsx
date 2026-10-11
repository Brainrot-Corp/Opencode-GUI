import { useRef, useState } from "react";
import { resolveForcedSide, type SplitForcedSide } from "../lib/splitHover";

export default function SplitReinstallDelete({
  busy,
  isRemoving,
  reinstallArmed,
  deleteArmed,
  reinstallTip,
  deleteTip,
  onReinstall,
  onDelete,
}: {
  busy: boolean;
  isRemoving: boolean;
  reinstallArmed: boolean;
  deleteArmed: boolean;
  reinstallTip: string;
  deleteTip: string;
  onReinstall: () => void;
  onDelete: () => void;
}) {
  const [forced, setForced] = useState<SplitForcedSide | null>(null);
  const lastX = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  function clear() {
    lastX.current = null;
    setForced(null);
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function rearmDecay() {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setForced(null);
    }, 350);
  }

  const disabled = isRemoving || busy;
  // armed confirm wins — never velocity-override it
  const locked = reinstallArmed || deleteArmed || disabled;

  return (
    <div
      className={`split-btn${forced === "reinstall" ? " force-reinstall" : forced === "delete" ? " force-delete" : ""}`}
      aria-label="Reinstall or delete"
      onMouseMove={(e) => {
        if (locked) return;
        const prev = lastX.current;
        lastX.current = e.clientX;
        if (prev == null) return;
        const side = resolveForcedSide(e.clientX - prev);
        if (side) {
          setForced(side);
          rearmDecay();
        }
      }}
      onMouseLeave={clear}
    >
      <button
        type="button"
        className={`split-half reinstall${reinstallArmed ? " armed" : ""}`}
        data-tip={reinstallTip}
        disabled={disabled}
        onClick={onReinstall}
      >
        <i className={`fa-solid ${reinstallArmed ? "fa-triangle-exclamation" : busy ? "fa-spinner fa-spin" : "fa-rotate"}`} />
        <span className="split-label">{reinstallArmed ? "Confirm" : busy ? "…" : "Reinstall"}</span>
      </button>
      <button
        type="button"
        className={`split-half delete${deleteArmed ? " armed" : ""}`}
        data-tip={deleteTip}
        disabled={disabled}
        onClick={onDelete}
      >
        <i className={`fa-solid ${deleteArmed ? "fa-triangle-exclamation" : "fa-trash-can"}`} />
        <span className="split-label">{deleteArmed ? "Confirm" : isRemoving ? "…" : "Delete"}</span>
      </button>
    </div>
  );
}
