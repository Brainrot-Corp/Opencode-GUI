import { useToastState, dismissToast } from "../hooks/useToast";

export default function ToastStack() {
  const toasts = useToastState();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.variant}`} role="status">
          <i className={`fa-solid ${t.variant === "error" ? "fa-circle-exclamation" : t.variant === "success" ? "fa-circle-check" : "fa-circle-info"} toast-icon`} aria-hidden />
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <i className="fa-solid fa-xmark" />
          </button>
          {t.ttl > 0 && (
            <div className="toast-progress" style={{ animationDuration: `${t.ttl}ms` } as React.CSSProperties} aria-hidden />
          )}
        </div>
      ))}
    </div>
  );
}
