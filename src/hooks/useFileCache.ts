import { useCallback, useEffect, useSyncExternalStore } from "react";
import { opencode } from "../api";

export type FileNode = {
  name: string;
  path: string;
  absolute: string;
  type: "file" | "directory";
  ignored: boolean;
};

let kids = new Map<string, FileNode[]>();
let err = "";
let loadingPath = "";
const pending = new Map<string, Promise<FileNode[]>>();
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

async function fetchKids(path: string, retries = 2): Promise<FileNode[]> {
  if (pending.has(path)) return pending.get(path)!;
  // dedupe: if cached and not forced, reuse (caller decides force via cache delete)
  const p = (async () => {
    loadingPath = path;
    notify();
    try {
      const { client } = await opencode();
      const r = await client.file.list({ query: { path } });
      const nodes = ((r.data ?? []) as FileNode[]).slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      kids = new Map(kids).set(path, nodes);
      err = "";
      return nodes;
    } catch (e: any) {
      if (retries > 0 && path === "") {
        // boot race — retry keeps skeleton until complete
        await new Promise((res) => setTimeout(res, 800));
        pending.delete(path);
        return fetchKids(path, retries - 1);
      }
      err = String(e);
      throw e;
    } finally {
      loadingPath = "";
      pending.delete(path);
      notify();
    }
  })();
  pending.set(path, p);
  return p;
}

export function getFileKids() {
  return kids;
}
export function getFileError() {
  return err;
}
export function getFileLoading() {
  return loadingPath;
}
export function invalidateFileCache(path?: string) {
  if (path === undefined) {
    kids = new Map();
  } else {
    const next = new Map(kids);
    next.delete(path);
    // also drop children under path
    for (const k of [...next.keys()]) if (k === path || k.startsWith(path + "/")) next.delete(k);
    kids = next;
  }
  err = "";
  notify();
}

let watcherSetup = false;
function setupWatcher() {
  if (watcherSetup) return;
  watcherSetup = true;
  window.addEventListener("oc:file-changed", ((e: Event) => {
    const raw = (e as CustomEvent<string>).detail || "";
    if (!raw) return;
    const norm = raw.replace(/\\/g, "/");
    // absolute paths (contain ":") — invalidate root to stay correct
    if (norm.includes(":") || norm.startsWith("/")) {
      if (kids.has("")) {
        invalidateFileCache("");
        void fetchKids("").catch(() => {});
      }
      return;
    }
    const slash = norm.lastIndexOf("/");
    const parent = slash >= 0 ? norm.slice(0, slash) : "";
    if (kids.has(parent)) {
      invalidateFileCache(parent);
      void fetchKids(parent).catch(() => {});
    } else if (kids.has("")) {
      // file in uncached dir — refresh root to show new entry if at top level
      invalidateFileCache("");
      void fetchKids("").catch(() => {});
    }
  }) as EventListener);
}

export function useFileCache() {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  void v;
  // idle prefetch root on first subscriber + watcher for external changes
  useEffect(() => {
    setupWatcher();
    if (kids.has("") || pending.has("")) return;
    const run = () => void fetchKids("").catch(() => {});
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
    if (ric) {
      const id = ric(run, { timeout: 1500 });
      return () => (window as any).cancelIdleCallback?.(id);
    } else {
      const t = window.setTimeout(run, 120);
      return () => window.clearTimeout(t);
    }
  }, []);

  const load = useCallback((path: string, force = false) => {
    if (!force && kids.has(path)) return Promise.resolve(kids.get(path)!);
    return fetchKids(path).catch(() => undefined as any);
  }, []);

  const refresh = useCallback((path: string) => {
    const next = new Map(kids);
    next.delete(path);
    kids = next;
    notify();
    return fetchKids(path).catch(() => undefined as any);
  }, []);

  const invalidate = useCallback((path?: string) => invalidateFileCache(path), []);

  return {
    kids,
    error: err,
    loadingDir: loadingPath,
    load,
    refresh,
    invalidate,
    isLoading: (p: string) => loadingPath === p || pending.has(p),
  };
}
