import { useCallback, useSyncExternalStore } from "react";

export type ToastVariant = "error" | "info" | "success";
export type Toast = { id: number; message: string; variant: ToastVariant; ttl: number };

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

export function pushToast(message: string, opts?: { variant?: ToastVariant; ttl?: number }): number | undefined {
  const msg = message?.trim();
  if (!msg) return;
  const id = nextId++;
  const t: Toast = { id, message: msg, variant: opts?.variant ?? "error", ttl: opts?.ttl ?? 5000 };
  toasts = [...toasts, t];
  notify();
  if (t.ttl > 0) setTimeout(() => dismissToast(id), t.ttl);
  return id;
}

export function dismissToast(id: number) {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) notify();
}

export function useToastState(): Toast[] {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, []);
  const getSnap = useCallback(() => toasts, []);
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}

export function useToast() {
  const list = useToastState();
  return { toasts: list, push: pushToast, dismiss: dismissToast };
}

// convenience alias so call sites can `import { toast } from "..."`
export const toast = {
  push: pushToast,
  error: (m: string, ttl?: number) => pushToast(m, { variant: "error", ttl }),
  info: (m: string, ttl?: number) => pushToast(m, { variant: "info", ttl }),
  success: (m: string, ttl?: number) => pushToast(m, { variant: "success", ttl }),
  dismiss: dismissToast,
};
