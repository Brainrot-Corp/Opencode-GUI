// Per-window storage isolation — every OS window is its own process, but
// localStorage is shared across processes. Window-local state (workspace,
// active session, terminals, git panel UI, global-last model/agent/security)
// is therefore namespaced by the per-process scope id from Rust
// (`window_scope`): the primary window keeps the legacy keys verbatim (so
// cold-boot restore is unchanged) while secondary windows get a fresh
// `key::scope` namespace that no other window reads or writes.
//
// Shared prefs (theme, sounds, hotkeys, plugin config, per-session-id maps)
// stay on unscoped keys deliberately.
import { invoke } from "@tauri-apps/api/core";

let scope = "";
let primary = true;
let ready = false;

function fallbackScope(): string {
  try {
    let s = sessionStorage.getItem("oc.windowScope");
    if (!s) {
      s = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      sessionStorage.setItem("oc.windowScope", s);
    }
    return s;
  } catch {
    return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

// must run before first render (main.tsx gates createRoot on it) — every
// useState initializer calling windowKey() below depends on it.
export async function initWindowScope(): Promise<void> {
  try {
    const r = await invoke<{ scope: string; primary: boolean }>("window_scope");
    if (r && typeof r.scope === "string" && r.scope) {
      scope = r.scope;
      primary = r.primary !== false;
    } else {
      scope = fallbackScope();
      primary = true;
    }
  } catch {
    scope = fallbackScope();
    primary = true;
  } finally {
    ready = true;
  }
  // secondary windows heartbeat so the primary's GC below never collects a
  // live window's namespace (hourly is plenty — GC threshold is days).
  if (!primary) {
    try {
      localStorage.setItem(`oc.scope.${scope}`, String(Date.now()));
      window.setInterval(() => {
        try {
          localStorage.setItem(`oc.scope.${scope}`, String(Date.now()));
        } catch {}
      }, 3_600_000);
    } catch {}
  }
}

export function isSecondary(): boolean {
  return ready && !primary;
}

// window-local storage key — call at render/effect time (post-init), never
// at module scope (scope isn't known at import time).
export function windowKey(base: string): string {
  if (!ready || primary || !scope) return base;
  return `${base}::${scope}`;
}

// drop namespaces of long-dead secondary windows (they never clean up after
// themselves). Primary only — a single writer avoids GC races. Keeps the
// freshest few regardless of age so clock skew can't wipe a live window.
export function gcWindowScopes(): void {
  if (!ready || !primary) return;
  try {
    const marks = new Map<string, number>();
    const suffixed = new Map<string, string[]>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("oc.scope.")) {
        const id = k.slice("oc.scope.".length);
        const at = Number(localStorage.getItem(k)) || 0;
        if (id && id !== scope) marks.set(id, at);
      } else {
        const sep = k.lastIndexOf("::");
        if (sep > 0) {
          const id = k.slice(sep + 2);
          if (id && id !== scope) {
            const arr = suffixed.get(id) ?? [];
            arr.push(k);
            suffixed.set(id, arr);
          }
        }
      }
    }
    if (!suffixed.size) return;
    const ids = [...suffixed.keys()].sort((a, b) => (marks.get(b) ?? 0) - (marks.get(a) ?? 0));
    const stale = ids.slice(6).filter((id) => Date.now() - (marks.get(id) ?? 0) > 7 * 86_400_000);
    for (const id of stale) {
      for (const k of suffixed.get(id) ?? []) {
        try {
          localStorage.removeItem(k);
        } catch {}
      }
      try {
        localStorage.removeItem(`oc.scope.${id}`);
      } catch {}
    }
  } catch {}
}
