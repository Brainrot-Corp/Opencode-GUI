import { useCallback, useEffect, useSyncExternalStore } from "react";
import { opencode, opencodeFor } from "../api";

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

function cacheKey(dir: string, path: string) {
  return `${dir}\0${path}`;
}

async function fetchKids(path: string, retries = 2, dir = ""): Promise<FileNode[]> {
  const key = cacheKey(dir, path);
  if (pending.has(key)) return pending.get(key)!;
  const p = (async () => {
    loadingPath = key;
    notify();
    try {
      const { client } = dir ? await opencodeFor(dir) : await opencode();
      const r = await (client.file as any).list({ query: { path } });
      const nodes = ((r.data ?? []) as FileNode[]).slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      kids = new Map(kids).set(key, nodes);
      err = "";
      return nodes;
    } catch (e: any) {
      if (retries > 0 && path === "") {
        await new Promise((res) => setTimeout(res, 800));
        pending.delete(key);
        return fetchKids(path, retries - 1, dir);
      }
      err = String(e);
      throw e;
    } finally {
      loadingPath = "";
      pending.delete(key);
      notify();
    }
  })();
  pending.set(key, p);
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
export function invalidateFileCache(path?: string, dir = "") {
  if (path === undefined) {
    kids = new Map();
  } else {
    const key = cacheKey(dir, path);
    const next = new Map(kids);
    next.delete(key);
    for (const k of [...next.keys()]) {
      const [d, p] = k.split("\0");
      if (d !== dir) continue;
      if (p === path || p.startsWith(path + "/")) next.delete(k);
    }
    kids = next;
  }
  err = "";
  notify();
}

let watcherSetup = false;
const watcherTimers = new Map<string, number>();
function scheduleFetch(key: string, dir: string, path: string) {
  if (pending.has(key)) return;
  const prev = watcherTimers.get(key);
  if (prev) window.clearTimeout(prev);
  const id = window.setTimeout(() => {
    watcherTimers.delete(key);
    if (pending.has(key)) return;
    void fetchKids(path, 2, dir).catch(() => {});
  }, 180);
  watcherTimers.set(key, id);
}
function setupWatcher() {
  if (watcherSetup) return;
  watcherSetup = true;
  window.addEventListener("oc:file-changed", ((e: Event) => {
    const raw = (e as CustomEvent<string>).detail || "";
    if (!raw) return;
    const norm = raw.replace(/\\/g, "/");
    if (norm.includes(":") || norm.startsWith("/")) {
      // absolute — refresh root for primary dir (others via their own watchers)
      for (const k of kids.keys()) if (k.endsWith("\0")) scheduleFetch(k, k.split("\0")[0], "");
      return;
    }
    const slash = norm.lastIndexOf("/");
    const parent = slash >= 0 ? norm.slice(0, slash) : "";
    // schedule for any dir that has this parent cached
    for (const k of kids.keys()) {
      const [dir, p] = k.split("\0");
      if (p === parent) scheduleFetch(k, dir, parent);
    }
    // also root fallback
    for (const k of kids.keys()) if (k.endsWith("\0")) scheduleFetch(k, k.split("\0")[0], "");
  }) as EventListener);
}

export function useFileCache(dir = "") {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  void v;
  useEffect(() => {
    setupWatcher();
    const key = cacheKey(dir, "");
    if (kids.has(key) || pending.has(key)) return;
    const run = () => void fetchKids("", 2, dir).catch(() => {});
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
    if (ric) {
      const id = ric(run, { timeout: 1500 });
      return () => (window as any).cancelIdleCallback?.(id);
    } else {
      const t = window.setTimeout(run, 120);
      return () => window.clearTimeout(t);
    }
  }, [dir]);

  const load = useCallback((path: string, force = false) => {
    const key = cacheKey(dir, path);
    if (!force && kids.has(key)) return Promise.resolve(kids.get(key)!);
    return fetchKids(path, 2, dir).catch(() => undefined as any);
  }, [dir]);

  const refresh = useCallback((path: string) => {
    const key = cacheKey(dir, path);
    const next = new Map(kids);
    next.delete(key);
    kids = next;
    notify();
    return fetchKids(path, 2, dir).catch(() => undefined as any);
  }, [dir]);

  const invalidate = useCallback((path?: string) => invalidateFileCache(path, dir), [dir]);

  // view filtered to this dir
  const dirKids = new Map<string, FileNode[]>();
  for (const [k, v2] of kids) {
    const [d, p] = k.split("\0");
    if (d === dir) dirKids.set(p, v2);
  }
  const isLoading = useCallback((p: string) => {
    const k = cacheKey(dir, p);
    return loadingPath === k || pending.has(k);
  }, [dir]);

  return {
    kids: dirKids,
    error: err,
    loadingDir: loadingPath,
    load,
    refresh,
    invalidate,
    isLoading,
  };
}
