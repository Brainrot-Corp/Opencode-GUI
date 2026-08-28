import { useCallback, useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TerminalProfile = {
  id: string;
  name: string;
  path: string;
  args: string[];
  source: string;
  kind: string;
};

let cache: TerminalProfile[] | null = null;
let err: string | null = null;
let loading = false;
let pending: Promise<TerminalProfile[]> | null = null;
let version = 0;
const subs = new Set<() => void>();

function notify() {
  version++;
  for (const c of subs) c();
}
function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}
function getVersion() {
  return version;
}

export function fetchTerminalProfiles(force = false): Promise<TerminalProfile[]> {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && pending) return pending;
  loading = true;
  err = null;
  notify();
  pending = invoke<TerminalProfile[]>("list_terminals")
    .then((p) => {
      cache = Array.isArray(p) ? p : [];
      loading = false;
      pending = null;
      err = null;
      notify();
      return cache;
    })
    .catch((e) => {
      err = String(e);
      loading = false;
      pending = null;
      notify();
      throw e;
    });
  return pending;
}

export function invalidateTerminalProfiles() {
  cache = null;
  err = null;
  notify();
}

export function useTerminalProfiles() {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  void v; // trigger re-render on version change
  const profiles = cache ?? [];
  const error = err;
  const isLoading = loading && !cache;

  // prefetch on first subscriber via idle — shared cache means only one fetch
  useEffect(() => {
    if (cache !== null || loading) return;
    const run = () => void fetchTerminalProfiles().catch(() => {});
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
    if (ric) {
      const id = ric(run, { timeout: 2000 });
      return () => (window as any).cancelIdleCallback?.(id);
    } else {
      const t = window.setTimeout(run, 700);
      return () => window.clearTimeout(t);
    }
  }, []);

  const refresh = useCallback((force = true) => fetchTerminalProfiles(force).catch(() => {}), []);

  return { profiles, loading: isLoading, error, refresh, fetch: fetchTerminalProfiles };
}
