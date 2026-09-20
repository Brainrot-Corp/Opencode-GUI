import { useEffect } from "react";
import { createPortal } from "react-dom";

// shared full-screen image zoom — scrim + centered image, Esc or any click
// closes. Portals to body so it clears the chat/composer stacking contexts.
export default function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="img-lightbox" onClick={onClose} role="dialog" aria-label="Image preview">
      <img src={src} alt={alt ?? ""} onClick={onClose} />
    </div>,
    document.body,
  );
}
